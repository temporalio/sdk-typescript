import * as otel from '@opentelemetry/api';
import type { Next, WorkflowSignalInput, WorkflowStartInput, WorkflowClientInterceptor } from '@temporalio/client';
import { instrument, headersWithContext, RUN_ID_ATTR_KEY } from '../instrumentation';
import { SpanName, SPAN_DELIMITER } from '../workflow';

export interface InterceptorOptions {
  readonly tracer?: otel.Tracer;
}

/**
 * Intercepts calls to start a Workflow.
 *
 * Wraps the operation in an opentelemetry Span and passes it to the Workflow via headers.
 */
export class OpenTelemetryWorkflowClientInterceptor implements WorkflowClientInterceptor {
  protected readonly tracer: otel.Tracer;

  constructor(options?: InterceptorOptions) {
    this.tracer = options?.tracer ?? otel.trace.getTracer('@temporalio/interceptor-client');
  }

  async start(input: WorkflowStartInput, next: Next<WorkflowClientInterceptor, 'start'>): Promise<string> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_START}${SPAN_DELIMITER}${input.workflowType}`,
      fn: async (span) => {
        const headers = await headersWithContext(input.headers);
        const runId = await next({ ...input, headers });
        span.setAttribute(RUN_ID_ATTR_KEY, runId);
        return runId;
      },
    });
  }

  async signal(input: WorkflowSignalInput, next: Next<WorkflowClientInterceptor, 'signal'>): Promise<void> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_SIGNAL}${SPAN_DELIMITER}${input.signalName}`,
      fn: async () => {
        const headers = await headersWithContext(input.headers);
        await next({ ...input, headers });
      },
    });
  }
}
