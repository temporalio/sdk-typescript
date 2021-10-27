import * as otel from '@opentelemetry/api';
import {
  DataConverter,
  defaultDataConverter,
  Next,
  WorkflowClientCallsInterceptor,
  WorkflowStartInput,
} from '@temporalio/client';
import { SpanName, SPAN_DELIMITER } from '../workflow';
import { instrument } from '../instrumentation';
import { headersWithContext, RUN_ID_ATTR_KEY } from '@temporalio/common/lib/otel';

export interface InterceptorOptions {
  readonly tracer?: otel.Tracer;
  readonly dataConverter?: DataConverter;
}

/**
 * Intercepts calls to start a Workflow.
 *
 * Wraps the operation in an opentelemetry Span and passes it to the Workflow via headers.
 */
export class OpenTelemetryWorkflowClientCallsInterceptor implements WorkflowClientCallsInterceptor {
  protected readonly tracer: otel.Tracer;
  protected readonly dataConverter: DataConverter;

  constructor(options?: InterceptorOptions) {
    this.dataConverter = options?.dataConverter ?? defaultDataConverter;
    this.tracer = options?.tracer ?? otel.trace.getTracer('@temporalio/client');
  }

  async start(input: WorkflowStartInput, next: Next<WorkflowClientCallsInterceptor, 'start'>): Promise<string> {
    return await instrument(
      this.tracer,
      `${SpanName.WORKFLOW_START}${SPAN_DELIMITER}${input.workflowType}`,
      async (span) => {
        const headers = await headersWithContext(input.headers);
        const runId = await next({ ...input, headers });
        span.setAttribute(RUN_ID_ATTR_KEY, runId);
        return runId;
      }
    );
  }
}
