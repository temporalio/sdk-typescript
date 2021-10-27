import './runtime'; // Patch the Workflow isolate runtime for opentelemetry
import * as otel from '@opentelemetry/api';
import {
  ActivityInput,
  Next,
  StartChildWorkflowExecutionInput,
  WorkflowInboundCallsInterceptor,
  WorkflowOutboundCallsInterceptor,
  WorkflowExecuteInput,
  workflowInfo,
  ContinueAsNewInput,
} from '@temporalio/workflow';
import { extractContextFromHeaders, headersWithContext } from '@temporalio/common/lib/otel';
import { ContextManager } from './context-manager';
import { SpanExporter } from './span-exporter';
import { SpanName, SPAN_DELIMITER } from './definitions';
import * as tracing from '@opentelemetry/sdk-trace-base';
import { instrument } from '../instrumentation';

export * from './definitions';

let tracer: undefined | otel.Tracer = undefined;

function getTracer(): otel.Tracer {
  if (tracer === undefined) {
    const provider = new tracing.BasicTracerProvider();
    provider.addSpanProcessor(new tracing.SimpleSpanProcessor(new SpanExporter()));
    provider.register({ contextManager: new ContextManager() });
    tracer = provider.getTracer('@temporalio/workflow');
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
    const spanName = `${SpanName.WORKFLOW_EXECUTE}${SPAN_DELIMITER}${workflowInfo().workflowType}`;
    return await instrument(this.tracer, spanName, () => next(input), context);
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
    return await instrument(
      this.tracer,
      `${SpanName.ACTIVITY_START}${SPAN_DELIMITER}${input.activityType}`,
      async () => {
        const headers = await headersWithContext(input.headers);
        return next({
          ...input,
          headers,
        });
      }
    );
  }

  public async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>
  ): Promise<[Promise<string>, Promise<unknown>]> {
    return await instrument(
      this.tracer,
      `${SpanName.CHILD_WORKFLOW_START}${SPAN_DELIMITER}${input.workflowType}`,
      async () => {
        const headers = await headersWithContext(input.headers);
        return next({
          ...input,
          headers,
        });
      }
    );
  }

  public async continueAsNew(
    input: ContinueAsNewInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>
  ): Promise<never> {
    return await instrument(
      this.tracer,
      `${SpanName.CONTINUE_AS_NEW}${SPAN_DELIMITER}${input.options.workflowType}`,
      async () => {
        const headers = await headersWithContext(input.headers);
        return next({
          ...input,
          headers,
        });
      }
    );
  }
}
