import * as otel from '@opentelemetry/api';
import type {
  Next,
  WorkflowSignalInput,
  WorkflowSignalWithStartInput,
  WorkflowStartInput,
  WorkflowStartOutput,
  WorkflowStartUpdateInput,
  WorkflowStartUpdateOutput,
  WorkflowStartUpdateWithStartInput,
  WorkflowStartUpdateWithStartOutput,
  WorkflowQueryInput,
  WorkflowTerminateInput,
  WorkflowCancelInput,
  WorkflowDescribeInput,
  WorkflowClientInterceptor,
  TerminateWorkflowExecutionResponse,
  RequestCancelWorkflowExecutionResponse,
  DescribeWorkflowExecutionResponse,
} from '@temporalio/client';
import {
  instrument,
  headersWithContext,
  RUN_ID_ATTR_KEY,
  WORKFLOW_ID_ATTR_KEY,
  UPDATE_ID_ATTR_KEY,
  TERMINATE_REASON_ATTR_KEY,
} from '../instrumentation';
import { SpanName, SPAN_DELIMITER } from '../workflow/definitions';

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
        const headers = headersWithContext(input.headers);
        span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.options.workflowId);
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
      fn: async (span) => {
        span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.workflowExecution.workflowId);
        const headers = headersWithContext(input.headers);
        await next({ ...input, headers });
      },
    });
  }

  async startWithDetails(
    input: WorkflowStartInput,
    next: Next<WorkflowClientInterceptor, 'startWithDetails'>
  ): Promise<WorkflowStartOutput> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_START}${SPAN_DELIMITER}${input.workflowType}`,
      fn: async (span) => {
        const headers = headersWithContext(input.headers);
        span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.options.workflowId);
        const output = await next({ ...input, headers });
        span.setAttribute(RUN_ID_ATTR_KEY, output.runId);
        return output;
      },
    });
  }

  async startUpdate(
    input: WorkflowStartUpdateInput,
    next: Next<WorkflowClientInterceptor, 'startUpdate'>
  ): Promise<WorkflowStartUpdateOutput> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_START_UPDATE}${SPAN_DELIMITER}${input.updateName}`,
      fn: async (span) => {
        span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.workflowExecution.workflowId);
        if (input.options.updateId) {
          span.setAttribute(UPDATE_ID_ATTR_KEY, input.options.updateId);
        }
        const headers = headersWithContext(input.headers);
        const output = await next({ ...input, headers });
        span.setAttribute(RUN_ID_ATTR_KEY, output.workflowRunId);
        return output;
      },
    });
  }

  async startUpdateWithStart(
    input: WorkflowStartUpdateWithStartInput,
    next: Next<WorkflowClientInterceptor, 'startUpdateWithStart'>
  ): Promise<WorkflowStartUpdateWithStartOutput> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_UPDATE_WITH_START}${SPAN_DELIMITER}${input.updateName}`,
      fn: async (span) => {
        span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.workflowStartOptions.workflowId);
        if (input.updateOptions.updateId) {
          span.setAttribute(UPDATE_ID_ATTR_KEY, input.updateOptions.updateId);
        }
        const workflowStartHeaders = headersWithContext(input.workflowStartHeaders);
        const updateHeaders = headersWithContext(input.updateHeaders);
        const output = await next({ ...input, workflowStartHeaders, updateHeaders });
        if (output.workflowExecution.runId) {
          span.setAttribute(RUN_ID_ATTR_KEY, output.workflowExecution.runId);
        }
        return output;
      },
    });
  }

  async signalWithStart(
    input: WorkflowSignalWithStartInput,
    next: Next<WorkflowClientInterceptor, 'signalWithStart'>
  ): Promise<string> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_SIGNAL_WITH_START}${SPAN_DELIMITER}${input.workflowType}`,
      fn: async (span) => {
        span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.options.workflowId);
        const headers = headersWithContext(input.headers);
        const runId = await next({ ...input, headers });
        span.setAttribute(RUN_ID_ATTR_KEY, runId);
        return runId;
      },
    });
  }

  async query(input: WorkflowQueryInput, next: Next<WorkflowClientInterceptor, 'query'>): Promise<unknown> {
    return await instrument({
      tracer: this.tracer,
      spanName: `${SpanName.WORKFLOW_QUERY}${SPAN_DELIMITER}${input.queryType}`,
      fn: async (span) => {
        const headers = headersWithContext(input.headers);
        span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.workflowExecution.workflowId);
        if (input.workflowExecution.runId) {
          span.setAttribute(RUN_ID_ATTR_KEY, input.workflowExecution.runId);
        }
        return await next({ ...input, headers });
      },
    });
  }

  async terminate(
    input: WorkflowTerminateInput,
    next: Next<WorkflowClientInterceptor, 'terminate'>
  ): Promise<TerminateWorkflowExecutionResponse> {
    return await instrument({
      tracer: this.tracer,
      spanName: SpanName.WORKFLOW_TERMINATE,
      fn: async (span) => {
        span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.workflowExecution.workflowId);
        if (input.workflowExecution.runId) {
          span.setAttribute(RUN_ID_ATTR_KEY, input.workflowExecution.runId);
        }
        if (input.reason) {
          span.setAttribute(TERMINATE_REASON_ATTR_KEY, input.reason);
        }
        return await next(input);
      },
    });
  }

  async cancel(
    input: WorkflowCancelInput,
    next: Next<WorkflowClientInterceptor, 'cancel'>
  ): Promise<RequestCancelWorkflowExecutionResponse> {
    return await instrument({
      tracer: this.tracer,
      spanName: SpanName.WORKFLOW_CANCEL,
      fn: async (span) => {
        span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.workflowExecution.workflowId);
        if (input.workflowExecution.runId) {
          span.setAttribute(RUN_ID_ATTR_KEY, input.workflowExecution.runId);
        }
        return await next(input);
      },
    });
  }

  async describe(
    input: WorkflowDescribeInput,
    next: Next<WorkflowClientInterceptor, 'describe'>
  ): Promise<DescribeWorkflowExecutionResponse> {
    return await instrument({
      tracer: this.tracer,
      spanName: SpanName.WORKFLOW_DESCRIBE,
      fn: async (span) => {
        span.setAttribute(WORKFLOW_ID_ATTR_KEY, input.workflowExecution.workflowId);
        if (input.workflowExecution.runId) {
          span.setAttribute(RUN_ID_ATTR_KEY, input.workflowExecution.runId);
        }
        return await next(input);
      },
    });
  }
}
