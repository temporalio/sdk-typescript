import { getCurrentTrace, withCustomSpan } from '@openai/agents-core';
import type {
  Next,
  WorkflowClientInterceptor,
  WorkflowStartInput,
  WorkflowStartOutput,
  WorkflowSignalInput,
  WorkflowSignalWithStartInput,
  WorkflowQueryInput,
  WorkflowStartUpdateInput,
  WorkflowStartUpdateOutput,
  WorkflowStartUpdateWithStartInput,
  WorkflowStartUpdateWithStartOutput,
} from '@temporalio/client';
import {
  currentAgentsSpanHeader,
  injectAgentsConfigHeader,
  injectAgentsTraceHeader,
  type AgentsConfigHeader,
} from '../common/headers';
import type { SerializableModelActivityOptions } from '../common/model-activity-options';

export interface OpenAIAgentsTraceClientInterceptorOptions {
  /** Wrap client calls in `temporal:*` custom spans. @default false */
  addTemporalSpans?: boolean;
  /** Emit OTel spans on the Workflow side for agent-SDK trace/span events. @default false */
  useOtelInstrumentation?: boolean;
  /** Model Activity options propagated to the Workflow via the config header. */
  modelParams?: SerializableModelActivityOptions;
}

export class OpenAIAgentsTraceClientInterceptor implements WorkflowClientInterceptor {
  private readonly addTemporalSpans: boolean;
  private readonly configHeader: AgentsConfigHeader;

  // Snapshots plugin config at construction time; injected into every
  // Workflow-starting call. Post-construction changes are not reflected.
  constructor(options?: OpenAIAgentsTraceClientInterceptorOptions) {
    this.addTemporalSpans = options?.addTemporalSpans === true;
    this.configHeader = {
      addTemporalSpans: options?.addTemporalSpans,
      useOtelInstrumentation: options?.useOtelInstrumentation,
      modelParams: options?.modelParams,
    };
  }

  private maybeSpan<T>(spanName: string, fn: () => Promise<T>, data?: Record<string, unknown>): Promise<T> {
    if (this.addTemporalSpans && getCurrentTrace()) {
      return withCustomSpan(() => fn(), { data: { name: spanName, data: data ?? {} } });
    }
    return fn();
  }

  // Captures the header INSIDE the span body so the propagated spanId is the
  // temporal span's own — the receiving Workflow inbound interceptor parents
  // its `temporal:executeWorkflow:*` under it.
  private async withSpanAndHeader<T>(
    spanName: string,
    spanData: Record<string, unknown>,
    withHeader: (header: ReturnType<typeof currentAgentsSpanHeader>) => Promise<T>
  ): Promise<T> {
    const doRun = (): Promise<T> => withHeader(currentAgentsSpanHeader());
    return this.maybeSpan(spanName, doRun, spanData);
  }

  async startWithDetails(
    input: WorkflowStartInput,
    next: Next<WorkflowClientInterceptor, 'startWithDetails'>
  ): Promise<WorkflowStartOutput> {
    const headers = injectAgentsConfigHeader(input.headers, this.configHeader);
    return this.withSpanAndHeader(
      `temporal:startWorkflow:${input.workflowType}`,
      { workflowId: input.options.workflowId },
      (header) => next({ ...input, headers: injectAgentsTraceHeader(headers, header) })
    );
  }

  async signal(input: WorkflowSignalInput, next: Next<WorkflowClientInterceptor, 'signal'>): Promise<void> {
    return this.withSpanAndHeader(
      `temporal:signalWorkflow:${input.signalName}`,
      { workflowId: input.workflowExecution.workflowId, signalName: input.signalName },
      (header) => next({ ...input, headers: injectAgentsTraceHeader(input.headers, header) })
    );
  }

  async query(input: WorkflowQueryInput, next: Next<WorkflowClientInterceptor, 'query'>): Promise<unknown> {
    return this.withSpanAndHeader(
      `temporal:queryWorkflow:${input.queryType}`,
      { workflowId: input.workflowExecution.workflowId, queryType: input.queryType },
      (header) => next({ ...input, headers: injectAgentsTraceHeader(input.headers, header) })
    );
  }

  async startUpdate(
    input: WorkflowStartUpdateInput,
    next: Next<WorkflowClientInterceptor, 'startUpdate'>
  ): Promise<WorkflowStartUpdateOutput> {
    return this.withSpanAndHeader(
      `temporal:updateWorkflow:${input.updateName}`,
      { workflowId: input.workflowExecution.workflowId, updateName: input.updateName },
      (header) => next({ ...input, headers: injectAgentsTraceHeader(input.headers, header) })
    );
  }

  async signalWithStart(
    input: WorkflowSignalWithStartInput,
    next: Next<WorkflowClientInterceptor, 'signalWithStart'>
  ): Promise<string> {
    const headers = injectAgentsConfigHeader(input.headers, this.configHeader);
    return this.withSpanAndHeader(
      `temporal:signalWithStartWorkflow:${input.workflowType}`,
      { signalName: input.signalName },
      (header) => next({ ...input, headers: injectAgentsTraceHeader(headers, header) })
    );
  }

  async startUpdateWithStart(
    input: WorkflowStartUpdateWithStartInput,
    next: Next<WorkflowClientInterceptor, 'startUpdateWithStart'>
  ): Promise<WorkflowStartUpdateWithStartOutput> {
    const workflowStartHeaders = injectAgentsConfigHeader(input.workflowStartHeaders, this.configHeader);
    return this.withSpanAndHeader(
      `temporal:startUpdateWithStart:${input.workflowType}`,
      { workflowType: input.workflowType, updateName: input.updateName },
      (header) =>
        next({
          ...input,
          workflowStartHeaders: injectAgentsTraceHeader(workflowStartHeaders, header),
          updateHeaders: injectAgentsTraceHeader(input.updateHeaders, header),
        })
    );
  }
}
