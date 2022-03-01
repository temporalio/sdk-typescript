import * as otel from '@opentelemetry/api';
import { Next, WorkflowClientCallsInterceptor, WorkflowStartInput } from '@temporalio/client';
import { headersWithContext, RUN_ID_ATTR_KEY } from '@temporalio/internal-non-workflow-common/lib/otel';
import { instrument } from '../instrumentation';
import { SpanName, SPAN_DELIMITER } from '../workflow';

export interface InterceptorOptions {
  readonly tracer?: otel.Tracer;
}

/**
 * Intercepts calls to start a Workflow.
 *
 * Wraps the operation in an opentelemetry Span and passes it to the Workflow via headers.
 */
export class OpenTelemetryWorkflowClientCallsInterceptor implements WorkflowClientCallsInterceptor {
  protected readonly tracer: otel.Tracer;

  constructor(options?: InterceptorOptions) {
    this.tracer = options?.tracer ?? otel.trace.getTracer('@temporalio/interceptor-client');
  }

  async start(input: WorkflowStartInput, next: Next<WorkflowClientCallsInterceptor, 'start'>): Promise<string> {
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
}
