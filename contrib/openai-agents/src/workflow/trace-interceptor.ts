import { createCustomSpan, getCurrentTrace } from '@openai/agents-core';
import {
  getRandomStream,
  workflowInfo,
  type ActivityInput,
  type ContinueAsNewInput,
  type DisposeInput,
  type Headers,
  type LocalActivityInput,
  type Next,
  type QueryInput,
  type SignalInput,
  type SignalWorkflowInput,
  type StartChildWorkflowExecutionInput,
  type StartNexusOperationInput,
  type StartNexusOperationOutput,
  type UpdateInput,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInternalsInterceptor,
  type WorkflowInterceptors,
  type WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';
import { getActivator } from '@temporalio/workflow/lib/global-attributes';
import {
  currentAgentsSpanHeader,
  extractAgentsConfigHeader,
  extractAgentsTraceHeader,
  injectAgentsConfigHeader,
  injectAgentsTraceHeader,
  injectAgentsTraceHeaderNexus,
} from '../common/headers';
import {
  withRestoredAgentsTraceContext,
  withIsolatedAgentsTraceContext,
  withSpanAsCurrent,
} from '../common/trace-context';
import { DEFAULT_MODEL_ACTIVITY_OPTIONS } from '../common/model-activity-options';
import {
  captureHeaderUnderMaybeInstantSpan,
  isFireAndForgetActivity,
  shouldAddTemporalSpans,
  maybeTemporalSpan,
  withInjectedHeader,
} from './span-helpers';
import { getCurrentPluginConfig, setPluginConfig, clearPluginConfig, type PluginConfig } from './plugin-config-store';
import { ensureTracingProcessorRegistered, runWithTracingRandom } from './tracing';
import { clearOpenSpans, flushOpenSpans } from './agent-sink-processor';
import { prngFromInputId, spanIdFromInputId } from './prng';

const TRACING_STREAM_NAME = 'package-openai-agents-tracing';

function tracingRandom(): number {
  return getRandomStream(TRACING_STREAM_NAME).random();
}

// Temporal Core hard-codes queryId === 'legacy_query' on the legacy single-Query
// Workflow Task path, so distinct Queries collide on the spanId/PRNG seed.
function resolveQueryKey(input: QueryInput): string {
  if (input.queryId !== 'legacy_query') return input.queryId;
  // Legacy queries arrive one at a time with a hardcoded id.
  return `${input.queryName}:${getActivator().getTimeOfDay()}`;
}

/**
 * Inbound interceptor: populates the per-Workflow plugin-config store from
 * the propagated config header and restores agent trace context.
 */
class OpenAIAgentsTraceInboundInterceptor implements WorkflowInboundCallsInterceptor {
  async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    ensureTracingProcessorRegistered();

    const configHeader = extractAgentsConfigHeader(input.headers);
    if (configHeader) {
      const headerConfig: PluginConfig = {
        addTemporalSpans: configHeader.addTemporalSpans ?? false,
        useOtelInstrumentation: configHeader.useOtelInstrumentation ?? false,
        modelParams: { ...DEFAULT_MODEL_ACTIVITY_OPTIONS, ...configHeader.modelParams },
      };
      setPluginConfig(headerConfig);
    }

    try {
      return await runWithTracingRandom(tracingRandom, () => {
        const header = extractAgentsTraceHeader(input.headers);
        if (!header?.traceId) {
          return maybeTemporalSpan(`temporal:executeWorkflow:${workflowInfo().workflowType}`, () => next(input));
        }

        return withRestoredAgentsTraceContext(header, () =>
          maybeTemporalSpan(`temporal:executeWorkflow:${workflowInfo().workflowType}`, () => next(input))
        );
      });
    } finally {
      await flushOpenSpans();
    }
  }

  async handleSignal(input: SignalInput, next: Next<WorkflowInboundCallsInterceptor, 'handleSignal'>): Promise<void> {
    return runWithTracingRandom(tracingRandom, () => {
      const header = extractAgentsTraceHeader(input.headers);
      if (!header?.traceId) {
        // Isolate: avoid inheriting the body's outbound Activity span as parent.
        return withIsolatedAgentsTraceContext(() =>
          maybeTemporalSpan(`temporal:handleSignal:${input.signalName}`, () => next(input), {
            signalName: input.signalName,
          })
        );
      }

      return withRestoredAgentsTraceContext(header, () =>
        maybeTemporalSpan(`temporal:handleSignal:${input.signalName}`, () => next(input), {
          signalName: input.signalName,
        })
      );
    });
  }

  async handleQuery(input: QueryInput, next: Next<WorkflowInboundCallsInterceptor, 'handleQuery'>): Promise<unknown> {
    const keyInput = resolveQueryKey(input);
    return runWithTracingRandom(prngFromInputId(keyInput), () => {
      const header = extractAgentsTraceHeader(input.headers);
      const spanId = spanIdFromInputId(keyInput);

      if (!header?.traceId) {
        return withIsolatedAgentsTraceContext(() =>
          maybeTemporalSpan(
            `temporal:handleQuery:${input.queryName}`,
            () => next(input),
            { queryName: input.queryName },
            spanId
          )
        );
      }

      return withRestoredAgentsTraceContext(header, () =>
        maybeTemporalSpan(
          `temporal:handleQuery:${input.queryName}`,
          () => next(input),
          { queryName: input.queryName },
          spanId
        )
      );
    });
  }

  validateUpdate(input: UpdateInput, next: Next<WorkflowInboundCallsInterceptor, 'validateUpdate'>): void {
    return runWithTracingRandom(prngFromInputId(input.updateId), () => {
      const spanId = spanIdFromInputId(input.updateId);
      const runValidate = () =>
        maybeTemporalSpan(
          `temporal:validateUpdate:${input.name}`,
          () => next(input),
          { updateName: input.name },
          spanId
        );
      const header = extractAgentsTraceHeader(input.headers);
      if (!header?.traceId) {
        return withIsolatedAgentsTraceContext(runValidate);
      }
      return withRestoredAgentsTraceContext(header, runValidate);
    });
  }

  async handleUpdate(
    input: UpdateInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleUpdate'>
  ): Promise<unknown> {
    return runWithTracingRandom(tracingRandom, () => {
      const header = extractAgentsTraceHeader(input.headers);
      if (!header?.traceId) {
        return withIsolatedAgentsTraceContext(() =>
          maybeTemporalSpan(`temporal:handleUpdate:${input.name}`, () => next(input), {
            updateName: input.name,
          })
        );
      }

      return withRestoredAgentsTraceContext(header, () =>
        maybeTemporalSpan(`temporal:handleUpdate:${input.name}`, () => next(input), {
          updateName: input.name,
        })
      );
    });
  }
}

/** Outbound interceptor: injects agent trace/span context into outbound headers under `__openai_span` and (for child Workflows / continueAsNew) the plugin config under `__openai_agents_config`. */
class OpenAIAgentsTraceOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  async scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>
  ): Promise<unknown> {
    if (isFireAndForgetActivity(input.activityType) && shouldAddTemporalSpans() && getCurrentTrace()) {
      // Lifetime span over the fire-and-forget Activity. Span is current only
      // during next(); kept open afterwards via resultPromise.finally so it
      // doesn't parent unrelated body spans.
      const span = createCustomSpan({
        data: { name: `temporal:startActivity:${input.activityType}`, data: { activityType: input.activityType } },
      });
      span.start();
      let resultPromise: Promise<unknown>;
      try {
        await withSpanAsCurrent(span, async () => {
          const headers = injectAgentsTraceHeader(input.headers, currentAgentsSpanHeader());
          resultPromise = next({ ...input, headers });
        });
      } catch (e) {
        span.end();
        throw e;
      }
      resultPromise!.finally(() => span.end()).catch(() => {});
      return resultPromise!;
    }
    return withInjectedHeader(input, next, {
      name: `temporal:startActivity:${input.activityType}`,
      data: { activityType: input.activityType },
    });
  }

  async scheduleLocalActivity(
    input: LocalActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>
  ): Promise<unknown> {
    return withInjectedHeader(input, next, {
      name: `temporal:startLocalActivity:${input.activityType}`,
      data: { activityType: input.activityType },
    });
  }

  async startNexusOperation(
    input: StartNexusOperationInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startNexusOperation'>
  ): Promise<StartNexusOperationOutput> {
    const spanName = `temporal:startNexusOperation:${input.service}.${input.operation}`;
    const data = { service: input.service, operation: input.operation, endpoint: input.endpoint };
    // next(input) resolves at Operation start, so the span covers schedule→start only — not full Operation duration.
    const doInject = (): Promise<StartNexusOperationOutput> => {
      const header = currentAgentsSpanHeader();
      const headers = injectAgentsTraceHeaderNexus(input.headers, header);
      return next({ ...input, headers });
    };
    return maybeTemporalSpan(spanName, doInject, data);
  }

  async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>
  ): Promise<[Promise<string>, Promise<unknown>]> {
    let headers = injectConfigHeaderFromStore(input.headers);

    if (shouldAddTemporalSpans() && getCurrentTrace()) {
      // Span is current only during next(); kept open afterwards via
      // resultPromise.finally for its end-timing.
      const span = createCustomSpan({
        data: { name: `temporal:startChildWorkflow:${input.workflowType}`, data: { workflowType: input.workflowType } },
      });
      span.start();
      let startedPromise: Promise<string>, resultPromise: Promise<unknown>;
      try {
        await withSpanAsCurrent(span, async () => {
          headers = injectAgentsTraceHeader(headers, currentAgentsSpanHeader());
          [startedPromise, resultPromise] = await next({ ...input, headers });
        });
      } catch (e) {
        span.end();
        throw e;
      }
      resultPromise!.finally(() => span.end()).catch(() => {});
      return [startedPromise!, resultPromise!];
    }

    headers = injectAgentsTraceHeader(headers, currentAgentsSpanHeader());
    return next({ ...input, headers });
  }

  async signalWorkflow(
    input: SignalWorkflowInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'signalWorkflow'>
  ): Promise<void> {
    return withInjectedHeader(input, next, {
      name: `temporal:signalWorkflow:${input.signalName}`,
      data: { signalName: input.signalName },
    });
  }

  async continueAsNew(
    input: ContinueAsNewInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>
  ): Promise<never> {
    // INSTANT span: continueAsNew always throws to terminate, so a
    // lifetime-span would never close.
    const headersWithConfig = injectConfigHeaderFromStore(input.headers);
    const header = captureHeaderUnderMaybeInstantSpan('temporal:continueAsNew', {});
    return next({ ...input, headers: injectAgentsTraceHeader(headersWithConfig, header) });
  }
}

function injectConfigHeaderFromStore(headers: Headers): Headers {
  const config = getCurrentPluginConfig();
  if (!config) return headers;

  return injectAgentsConfigHeader(headers, {
    addTemporalSpans: config.addTemporalSpans,
    useOtelInstrumentation: config.useOtelInstrumentation,
    modelParams: config.modelParams,
  });
}

/**
 * Internals interceptor: clears Workflow-scoped plugin state on dispose. Covers the
 * eviction-while-suspended path where the Workflow never reaches a clean exit.
 *
 * Cleanup lives in `dispose` (not the Workflow body's `finally`) because `Span.end()`
 * on the outermost `temporal:executeWorkflow` span fans out `onSpanEnd` as a microtask
 * scheduled after the body promise resolves but before the caller resumes. Clearing
 * plugin config in `finally` would race that microtask and gate off OTel-bridge
 * emission of the outermost span itself.
 */
class OpenAIAgentsInternalsInterceptor implements WorkflowInternalsInterceptor {
  dispose(input: DisposeInput, next: Next<WorkflowInternalsInterceptor, 'dispose'>): void {
    clearPluginConfig();
    clearOpenSpans();
    return next(input);
  }
}

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [new OpenAIAgentsTraceInboundInterceptor()],
  outbound: [new OpenAIAgentsTraceOutboundInterceptor()],
  internals: [new OpenAIAgentsInternalsInterceptor()],
});
