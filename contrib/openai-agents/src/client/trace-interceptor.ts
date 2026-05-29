import { getCurrentTrace, withCustomSpan } from '@openai/agents-core';
import type {
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

// Concrete `next` types: avoid the circular `Next<this, ...>` resolution that
// triggers when a class method's own signature feeds back into `Next`.
type NextStartWithDetails = (input: WorkflowStartInput) => Promise<WorkflowStartOutput>;
type NextSignal = (input: WorkflowSignalInput) => Promise<void>;
type NextQuery = (input: WorkflowQueryInput) => Promise<unknown>;
type NextStartUpdate = (input: WorkflowStartUpdateInput) => Promise<WorkflowStartUpdateOutput>;
type NextSignalWithStart = (input: WorkflowSignalWithStartInput) => Promise<string>;
type NextStartUpdateWithStart = (
  input: WorkflowStartUpdateWithStartInput
) => Promise<WorkflowStartUpdateWithStartOutput>;

// Structural typing — satisfies WorkflowClientInterceptor without `implements`,
// avoiding the same circular `Next<this, ...>` resolution noted above.
export class OpenAIAgentsTraceClientInterceptor {
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

  async startWithDetails(input: WorkflowStartInput, next: NextStartWithDetails): Promise<WorkflowStartOutput> {
    const headers = injectAgentsConfigHeader(input.headers, this.configHeader);
    return this.withSpanAndHeader(
      `temporal:startWorkflow:${input.workflowType}`,
      { workflowId: input.options.workflowId },
      (header) => next({ ...input, headers: injectAgentsTraceHeader(headers, header) })
    );
  }

  async signal(input: WorkflowSignalInput, next: NextSignal): Promise<void> {
    return this.withSpanAndHeader(
      `temporal:signalWorkflow:${input.signalName}`,
      { workflowId: input.workflowExecution.workflowId, signalName: input.signalName },
      (header) => next({ ...input, headers: injectAgentsTraceHeader(input.headers, header) })
    );
  }

  async query(input: WorkflowQueryInput, next: NextQuery): Promise<unknown> {
    return this.withSpanAndHeader(
      `temporal:queryWorkflow:${input.queryType}`,
      { workflowId: input.workflowExecution.workflowId, queryType: input.queryType },
      (header) => next({ ...input, headers: injectAgentsTraceHeader(input.headers, header) })
    );
  }

  async startUpdate(input: WorkflowStartUpdateInput, next: NextStartUpdate): Promise<WorkflowStartUpdateOutput> {
    return this.withSpanAndHeader(
      `temporal:updateWorkflow:${input.updateName}`,
      { workflowId: input.workflowExecution.workflowId, updateName: input.updateName },
      (header) => next({ ...input, headers: injectAgentsTraceHeader(input.headers, header) })
    );
  }

  async signalWithStart(input: WorkflowSignalWithStartInput, next: NextSignalWithStart): Promise<string> {
    const headers = injectAgentsConfigHeader(input.headers, this.configHeader);
    return this.withSpanAndHeader(
      `temporal:signalWithStartWorkflow:${input.workflowType}`,
      { signalName: input.signalName },
      (header) => next({ ...input, headers: injectAgentsTraceHeader(headers, header) })
    );
  }

  async startUpdateWithStart(
    input: WorkflowStartUpdateWithStartInput,
    next: NextStartUpdateWithStart
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
