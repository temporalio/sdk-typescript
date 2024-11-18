/* eslint-disable import/order */
// eslint-disable-next-line import/no-unassigned-import
import './runtime'; // Patch the Workflow isolate runtime for opentelemetry
import * as otel from '@opentelemetry/api';
import * as tracing from '@opentelemetry/sdk-trace-base';
import {
  ActivityInput,
  ContinueAsNew,
  ContinueAsNewInput,
  DisposeInput,
  Next,
  SignalInput,
  SignalWorkflowInput,
  StartChildWorkflowExecutionInput,
  WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor,
  workflowInfo,
  WorkflowInternalsInterceptor,
  WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';
import { instrument, extractContextFromHeaders, headersWithContext } from '../instrumentation';
import { ContextManager } from './context-manager';
import { SpanName, SPAN_DELIMITER } from './definitions';
import { SpanExporter } from './span-exporter';

export * from './definitions';

let tracer: undefined | otel.Tracer = undefined;
let contextManager: undefined | ContextManager = undefined;

function getTracer(): otel.Tracer {
  if (contextManager === undefined) {
    contextManager = new ContextManager();
  }
  if (tracer === undefined) {
    const provider = new tracing.BasicTracerProvider();
    provider.addSpanProcessor(new tracing.SimpleSpanProcessor(new SpanExporter()));
    provider.register({ contextManager });
    tracer = provider.getTracer('@temporalio/interceptor-workflow');
  }
  return tracer;
}

/**
 * Intercepts calls to run a Workflow
 *
 * Wraps the operation in an opentelemetry Span and links it to a parent Span context if one is
 * provided in the Workflow input headers.
 */
export class OpenTelemetryInboundInterceptor implements WorkflowInboundCallsInterceptor {
  protected readonly tracer = getTracer();

  public async execute(
    input: WorkflowExecuteInput,
    next: Next<WorkflowInboundCallsInterceptor, 'execute'>
  ): Promise<unknown> {
    const context = await extractContextFromHeaders(input.headers);
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
    const context = await extractContextFromHeaders(input.headers);
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_SIGNAL}${SPAN_DELIMITER}${input.signalName}`,
      fn: () => next(input),
      context,
    });
  }
}

/**
 * Intercepts outbound calls to schedule an Activity
 *
 * Wraps the operation in an opentelemetry Span and passes it to the Activity via headers.
 */
export class OpenTelemetryOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  protected readonly tracer = getTracer();

  public async scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>
  ): Promise<unknown> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.ACTIVITY_START}${SPAN_DELIMITER}${input.activityType}`,
      fn: async () => {
        const headers = await headersWithContext(input.headers);
        return next({
          ...input,
          headers,
        });
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
        const headers = await headersWithContext(input.headers);
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
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.CONTINUE_AS_NEW}${SPAN_DELIMITER}${input.options.workflowType}`,
      fn: async () => {
        const headers = await headersWithContext(input.headers);
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
        const headers = await headersWithContext(input.headers);
        return next({
          ...input,
          headers,
        });
      },
    });
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
