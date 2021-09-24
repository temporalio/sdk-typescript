import * as otel from '@opentelemetry/api';
import {
  DataConverter,
  defaultDataConverter,
  Next,
  WorkflowClientCallsInterceptor,
  WorkflowStartInput,
} from '@temporalio/client';
import { TRACE_HEADER, SpanName } from '../workflow';

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
    this.tracer = options?.tracer ?? otel.trace.getTracer('client');
  }

  async start(input: WorkflowStartInput, next: Next<WorkflowClientCallsInterceptor, 'start'>): Promise<string> {
    const span = this.tracer.startSpan(SpanName.WORKFLOW_SCHEDULE);
    const header = await this.dataConverter.toPayload(span.spanContext());
    try {
      return await next({ ...input, headers: { ...input.headers, [TRACE_HEADER]: header } });
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }
}
