/* eslint-disable import/order */
// eslint-disable-next-line import/no-unassigned-import
import './runtime'; // Patch the Workflow isolate runtime for opentelemetry
import * as otel from '@opentelemetry/api';
import * as tracing from '@opentelemetry/sdk-trace-base';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type {
  ActivityInput,
  ContinueAsNewInput,
  DisposeInput,
  GetLogAttributesInput,
  GetMetricTagsInput,
  LocalActivityInput,
  Next,
  QueryInput,
  SignalInput,
  SignalWorkflowInput,
  StartChildWorkflowExecutionInput,
  UpdateInput,
  WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor,
  WorkflowInternalsInterceptor,
  WorkflowOutboundCallsInterceptor,
  StartNexusOperationInput,
  StartNexusOperationOutput,
} from '@temporalio/workflow';
import {
  instrument,
  instrumentSync,
  extractContextFromHeaders,
  headersWithContext,
  UPDATE_ID_ATTR_KEY,
  NEXUS_SERVICE_ATTR_KEY,
  NEXUS_OPERATION_ATTR_KEY,
  NEXUS_ENDPOINT_ATTR_KEY,
} from '../instrumentation';
import { ContextManager } from './context-manager';
import { SpanName, SPAN_DELIMITER } from './definitions';
import { SpanExporter } from './span-exporter';
import { ensureWorkflowModuleLoaded, getWorkflowModule, hasSdkFlag } from './workflow-module-loader';

export * from './definitions';

let tracer: undefined | otel.Tracer = undefined;
let contextManager: undefined | ContextManager = undefined;

function getTracer(): otel.Tracer {
  if (contextManager === undefined) {
    contextManager = new ContextManager();
  }
  if (tracer === undefined) {
    const provider = new tracing.BasicTracerProvider(
      {
        spanProcessors: [
          new tracing.SimpleSpanProcessor(new SpanExporter())
        ]
      }
    );
    otel.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    otel.trace.setGlobalTracerProvider(provider);
    otel.context.setGlobalContextManager(contextManager);
    tracer = provider.getTracer('@temporalio/interceptor-workflow');
  }
  return tracer;
}

/**
 * Intercepts calls to run a Workflow
 *
 * Wraps the operation in an opentelemetry Span and links it to a parent Span context if one is
 * provided in the Workflow input headers.
 *
 * `@temporalio/workflow` must be provided by host package in order to function.
 */
export class OpenTelemetryInboundInterceptor implements WorkflowInboundCallsInterceptor {
  protected readonly tracer = getTracer();

  public constructor() {
    ensureWorkflowModuleLoaded();
  }

  public async execute(
    input: WorkflowExecuteInput,
    next: Next<WorkflowInboundCallsInterceptor, 'execute'>
  ): Promise<unknown> {
    const { workflowInfo, ContinueAsNew } = getWorkflowModule();

    const context = extractContextFromHeaders(input.headers);
    if (!hasSdkFlag('OpenTelemetryInterceporsAvoidsExtraYields')) await Promise.resolve();

    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_EXECUTE}${SPAN_DELIMITER}${workflowInfo().workflowType}`,
      fn: () => next(input),
      context,
      acceptableErrors: (err) => err instanceof ContinueAsNew,
    });
  }

  public async handleSignal(
    input: SignalInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleSignal'>
  ): Promise<void> {
    // Tracing of inbound signals was added in v1.11.5.
    if (!hasSdkFlag('OpenTelemetryInterceptorsTracesInboundSignals')) return next(input);

    const context = extractContextFromHeaders(input.headers);
    if (!hasSdkFlag('OpenTelemetryInterceporsAvoidsExtraYields')) await Promise.resolve();

    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_HANDLE_SIGNAL}${SPAN_DELIMITER}${input.signalName}`,
      fn: () => next(input),
      context,
    });
  }

  public async handleUpdate(
    input: UpdateInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleUpdate'>
  ): Promise<unknown> {
    if (!hasSdkFlag('OpenTelemetryInterceptorsInstrumentsAllMethods')) return next(input);

    const context = extractContextFromHeaders(input.headers);

    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_HANDLE_UPDATE}${SPAN_DELIMITER}${input.name}`,
      fn: (span) => {
        span.setAttribute(UPDATE_ID_ATTR_KEY, input.updateId);
        return next(input);
      },
      context,
    });
  }

  public validateUpdate(input: UpdateInput, next: Next<WorkflowInboundCallsInterceptor, 'validateUpdate'>): void {
    if (!hasSdkFlag('OpenTelemetryInterceptorsInstrumentsAllMethods')) return next(input);

    const context = extractContextFromHeaders(input.headers);
    instrumentSync({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_VALIDATE_UPDATE}${SPAN_DELIMITER}${input.name}`,
      fn: (span) => {
        span.setAttribute(UPDATE_ID_ATTR_KEY, input.updateId);
        return next(input);
      },
      context,
    });
  }

  public async handleQuery(
    input: QueryInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleQuery'>
  ): Promise<unknown> {
    if (!hasSdkFlag('OpenTelemetryInterceptorsInstrumentsAllMethods')) return next(input);

    const context = extractContextFromHeaders(input.headers);

    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_HANDLE_QUERY}${SPAN_DELIMITER}${input.queryName}`,
      fn: () => next(input),
      context,
    });
  }
}

/**
 * Intercepts outbound calls to schedule an Activity
 *
 * Wraps the operation in an opentelemetry Span and passes it to the Activity via headers.
 *
 * `@temporalio/workflow` must be provided by host package in order to function.
 */
export class OpenTelemetryOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  protected readonly tracer = getTracer();

  public constructor() {
    ensureWorkflowModuleLoaded();
  }

  public async scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>
  ): Promise<unknown> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.ACTIVITY_START}${SPAN_DELIMITER}${input.activityType}`,
      fn: async () => {
        const headers = headersWithContext(input.headers);
        if (!hasSdkFlag('OpenTelemetryInterceporsAvoidsExtraYields')) await Promise.resolve();

        return next({
          ...input,
          headers,
        });
      },
    });
  }

  public async scheduleLocalActivity(
    input: LocalActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>
  ): Promise<unknown> {
    // Tracing of local activities was added in v1.11.6.
    if (!hasSdkFlag('OpenTelemetryInterceptorsTracesLocalActivities')) return next(input);

    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.ACTIVITY_START}${SPAN_DELIMITER}${input.activityType}`,
      fn: async () => {
        const headers = headersWithContext(input.headers);
        if (!hasSdkFlag('OpenTelemetryInterceporsAvoidsExtraYields')) await Promise.resolve();

        return next({
          ...input,
          headers,
        });
      },
    });
  }

  public async startNexusOperation(
    input: StartNexusOperationInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startNexusOperation'>
  ): Promise<StartNexusOperationOutput> {
    if (!hasSdkFlag('OpenTelemetryInterceptorsInstrumentsAllMethods')) return next(input);

    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.NEXUS_OPERATION_START}${SPAN_DELIMITER}${input.service}${SPAN_DELIMITER}${input.operation}`,
      fn: async (span) => {
        span.setAttribute(NEXUS_SERVICE_ATTR_KEY, input.service);
        span.setAttribute(NEXUS_OPERATION_ATTR_KEY, input.operation);
        span.setAttribute(NEXUS_ENDPOINT_ATTR_KEY, input.endpoint);
        return await next(input);
      },
    });
  }

  public async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>
  ): Promise<[Promise<string>, Promise<unknown>]> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.CHILD_WORKFLOW_START}${SPAN_DELIMITER}${input.workflowType}`,
      fn: async () => {
        const headers = headersWithContext(input.headers);
        if (!hasSdkFlag('OpenTelemetryInterceporsAvoidsExtraYields')) await Promise.resolve();

        return next({
          ...input,
          headers,
        });
      },
    });
  }

  public async continueAsNew(
    input: ContinueAsNewInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>
  ): Promise<never> {
    const { ContinueAsNew } = getWorkflowModule();
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.CONTINUE_AS_NEW}${SPAN_DELIMITER}${input.options.workflowType}`,
      fn: async () => {
        const headers = headersWithContext(input.headers);
        if (!hasSdkFlag('OpenTelemetryInterceporsAvoidsExtraYields')) await Promise.resolve();

        return next({
          ...input,
          headers,
        });
      },
      acceptableErrors: (err) => err instanceof ContinueAsNew,
    });
  }

  public async signalWorkflow(
    input: SignalWorkflowInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'signalWorkflow'>
  ): Promise<void> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_SIGNAL}${SPAN_DELIMITER}${input.signalName}`,
      fn: async () => {
        const headers = headersWithContext(input.headers);
        if (!hasSdkFlag('OpenTelemetryInterceporsAvoidsExtraYields')) await Promise.resolve();

        return next({
          ...input,
          headers,
        });
      },
    });
  }

  public getLogAttributes(
    input: GetLogAttributesInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'getLogAttributes'>
  ): Record<string, unknown> {
    const span = otel.trace.getSpan(otel.context.active());
    const spanContext = span?.spanContext();
    if (spanContext && otel.isSpanContextValid(spanContext)) {
      return next({
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: `0${spanContext.traceFlags.toString(16)}`,
        ...input,
      });
    } else {
      return next(input);
    }
  }

  public getMetricTags(
    input: GetMetricTagsInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'getMetricTags'>
  ): GetMetricTagsInput {
    const span = otel.trace.getSpan(otel.context.active());
    const spanContext = span?.spanContext();
    if (spanContext && otel.isSpanContextValid(spanContext)) {
      return next({
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: `0${spanContext.traceFlags.toString(16)}`,
        ...input,
      });
    } else {
      return next(input);
    }
  }
}

export class OpenTelemetryInternalsInterceptor implements WorkflowInternalsInterceptor {
  async dispose(input: DisposeInput, next: Next<WorkflowInternalsInterceptor, 'dispose'>): Promise<void> {
    if (contextManager !== undefined) {
      contextManager.disable();
    }
    next(input);
  }
}
