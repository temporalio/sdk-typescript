/**
 * Type definitions for Workflow interceptors.
 *
 * @module
 */

import {
  ActivityOptions,
  Headers,
  LocalActivityOptions,
  MetricTags,
  Next,
  Timestamp,
  WorkflowExecution,
} from '@temporalio/common';
import type { coresdk } from '@temporalio/proto';
import { ChildWorkflowOptionsWithDefaults, ContinueAsNewOptions, StartNexusOperationOptions } from './interfaces';

export { Next, Headers };

/**
 * A function that instantiates {@link WorkflowInterceptors}.
 *
 * Workflow interceptor modules should export an `interceptors` function of this type.
 *
 * @example
 *
 * ```ts
 * export function interceptors(): WorkflowInterceptors {
 *   return {
 *     inbound: [],   // Populate with list of inbound interceptor implementations
 *     outbound: [],  // Populate with list of outbound interceptor implementations
 *     internals: [], // Populate with list of internals interceptor implementations
 *   };
 * }
 * ```
 */
export type WorkflowInterceptorsFactory = () => WorkflowInterceptors;

/**
 * A mapping from interceptor type to an optional list of interceptor implementations
 */
export interface WorkflowInterceptors {
  inbound?: WorkflowInboundCallsInterceptor[];
  outbound?: WorkflowOutboundCallsInterceptor[];
  internals?: WorkflowInternalsInterceptor[];
}

// Workflow Inbound Calls Interceptors /////////////////////////////////////////////////////////////////////////////////

/**
 * Implement any of these methods to intercept Workflow inbound calls like execution, and signal and query handling.
 */
export interface WorkflowInboundCallsInterceptor {
  /**
   * Called when Workflow execute method is called
   *
   * @return result of the Workflow execution
   */
  execute?: (input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>) => Promise<unknown>;

  /**
   * Called when Update handler is called
   *
   * @return result of the Update
   */
  handleUpdate?: (input: UpdateInput, next: Next<WorkflowInboundCallsInterceptor, 'handleUpdate'>) => Promise<unknown>;

  /**
   * Called when update validator called
   */
  validateUpdate?: (input: UpdateInput, next: Next<WorkflowInboundCallsInterceptor, 'validateUpdate'>) => void;

  /**
   * Called when signal is delivered to a Workflow execution
   */
  handleSignal?: (input: SignalInput, next: Next<WorkflowInboundCallsInterceptor, 'handleSignal'>) => Promise<void>;

  /**
   * Called when a Workflow is queried
   *
   * @return result of the query
   */
  handleQuery?: (input: QueryInput, next: Next<WorkflowInboundCallsInterceptor, 'handleQuery'>) => Promise<unknown>;
}

/**
 * Input for {@link WorkflowInboundCallsInterceptor.execute}.
 */
export interface WorkflowExecuteInput {
  readonly args: unknown[];
  readonly headers: Headers;
}

/**
 * Input for {@link WorkflowInboundCallsInterceptor.handleUpdate} and {@link WorkflowInboundCallsInterceptor.validateUpdate}.
 */
export interface UpdateInput {
  readonly updateId: string;
  readonly name: string;
  readonly args: unknown[];
  readonly headers: Headers;
}

/**
 * Input for {@link WorkflowInboundCallsInterceptor.handleSignal}.
 */
export interface SignalInput {
  readonly signalName: string;
  readonly args: unknown[];
  readonly headers: Headers;
}

/**
 * Input for {@link WorkflowInboundCallsInterceptor.handleQuery}.
 */
export interface QueryInput {
  readonly queryId: string;
  readonly queryName: string;
  readonly args: unknown[];
  readonly headers: Headers;
}

// Workflow Outbound Calls Interceptors /////////////////////////////////////////////////////////////////////////////////

/**
 * Implement any of these methods to intercept Workflow code calls to the Temporal APIs, like scheduling an activity
 * and starting a timer.
 */
export interface WorkflowOutboundCallsInterceptor {
  /**
   * Called when Workflow starts a timer.
   */
  startTimer?: (input: TimerInput, next: Next<WorkflowOutboundCallsInterceptor, 'startTimer'>) => Promise<void>;

  /**
   * Called when Workflow schedules an Activity.
   *
   * @return result of the activity execution
   */
  scheduleActivity?: (
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>
  ) => Promise<unknown>;

  /**
   * Called when Workflow schedules a local Activity.
   *
   * @return result of the activity execution
   */
  scheduleLocalActivity?: (
    input: LocalActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>
  ) => Promise<unknown>;

  /**
   * Called when Workflow starts a child workflow execution.
   *
   * The interceptor function returns 2 promises:
   * - The first resolves with the `runId` when the child workflow has started or rejects if failed to start.
   * - The second resolves with the workflow result when the child workflow completes or rejects on failure.
   */
  startChildWorkflowExecution?: (
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>
  ) => Promise<[Promise<string>, Promise<unknown>]>;

  /**
   * Called when Workflow signals a child or external Workflow.
   */
  signalWorkflow?: (
    input: SignalWorkflowInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'signalWorkflow'>
  ) => Promise<void>;

  /**
   * Called when Workflow calls continueAsNew.
   */
  continueAsNew?: (
    input: ContinueAsNewInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>
  ) => Promise<never>;

  /**
   * Called on each invocation of the `workflow.log` methods.
   *
   * The attributes returned in this call are attached to every log message.
   */
  getLogAttributes?: (
    input: GetLogAttributesInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'getLogAttributes'>
  ) => Record<string, unknown>;

  /**
   * Called once every time a metric is emitted from a Workflow metric (ie. a metric created
   * from {@link workflow.metricMeter}).
   *
   * Tags returned by this hook are _prepended_ to tags defined at the metric level and tags
   * defined on the emitter function itself.
   */
  getMetricTags?: (
    input: GetMetricTagsInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'getMetricTags'>
  ) => MetricTags;
}

/**
 * Input for {@link WorkflowOutboundCallsInterceptor.startTimer}
 */
export interface TimerInput {
  readonly durationMs: number;
  readonly seq: number;
  readonly options?: TimerOptions;
}

/**
 * Options for starting a timer (i.e. sleep)
 */
export interface TimerOptions {
  /** @experimental A fixed, single line summary of the command's purpose */
  readonly summary?: string;
}

/**
 * Input for {@link WorkflowOutboundCallsInterceptor.scheduleActivity}.
 */
export interface ActivityInput {
  readonly activityType: string;
  readonly args: unknown[];
  readonly options: ActivityOptions;
  readonly headers: Headers;
  readonly seq: number;
}

/**
 * Input for {@link WorkflowOutboundCallsInterceptor.scheduleLocalActivity}.
 */
export interface LocalActivityInput {
  readonly activityType: string;
  readonly args: unknown[];
  readonly options: LocalActivityOptions;
  readonly headers: Headers;
  readonly seq: number;
  readonly originalScheduleTime?: Timestamp;
  readonly attempt: number;
}

/**
 * Input for {@link WorkflowOutboundCallsInterceptor.startChildWorkflowExecution}.
 */
export interface StartChildWorkflowExecutionInput {
  readonly workflowType: string;
  readonly options: ChildWorkflowOptionsWithDefaults;
  readonly headers: Headers;
  readonly seq: number;
}

/**
 * Input for {@link WorkflowOutboundCallsInterceptor.signalWorkflow}.
 */
export interface SignalWorkflowInput {
  readonly seq: number;
  readonly signalName: string;
  readonly args: unknown[];
  readonly headers: Headers;
  readonly target:
    | {
        readonly type: 'external';
        readonly workflowExecution: WorkflowExecution;
      }
    | {
        readonly type: 'child';
        readonly childWorkflowId: string;
      };
}

/**
 * Input for {@link WorkflowOutboundCallsInterceptor.continueAsNew}.
 */
export interface ContinueAsNewInput {
  readonly args: unknown[];
  readonly headers: Headers;
  readonly options: ContinueAsNewInputOptions;
}

/**
 * Input for {@link WorkflowOutboundCallsInterceptor.continueAsNew}.
 */
export type ContinueAsNewInputOptions = ContinueAsNewOptions & Required<Pick<ContinueAsNewOptions, 'workflowType'>>;

/**
 * Input for {@link WorkflowOutboundCallsInterceptor.startNexusOperation}.
 */
export interface StartNexusOperationInput {
  input: unknown;
  endpoint: string;
  service: string;
  options: StartNexusOperationOptions;
  operation: string;
  seq: number;
  nexusHeader: Record<string, string>;
}

/**
 * Output for {@link WorkflowOutboundCallsInterceptor.startNexusOperation}.
 */
export interface StartNexusOperationOutput {
  token?: string;
}

/**
 * Input for {@link WorkflowOutboundCallsInterceptor.getLogAttributes}.
 */
export type GetLogAttributesInput = Record<string, unknown>;

/**
 * Input for {@link WorkflowOutboundCallsInterceptor.getMetricTags}.
 */
export type GetMetricTagsInput = MetricTags;

// Workflow Internals Interceptors /////////////////////////////////////////////////////////////////////////////////////

/**
 * Interceptor for the internals of the Workflow runtime.
 *
 * Use to manipulate or trace Workflow activations.
 *
 * @experimental This API is for advanced use cases and may change in the future.
 */
export interface WorkflowInternalsInterceptor {
  /**
   * Called when the Workflow runtime runs a WorkflowActivationJob.
   */
  activate?(input: ActivateInput, next: Next<this, 'activate'>): void;

  /**
   * Called after all `WorkflowActivationJob`s have been processed for an activation.
   *
   * Can manipulate the commands generated by the Workflow
   */
  concludeActivation?(input: ConcludeActivationInput, next: Next<this, 'concludeActivation'>): ConcludeActivationOutput;

  /**
   * Called before disposing the Workflow isolate context.
   *
   * Implement this method to perform any resource cleanup.
   */
  dispose?(input: DisposeInput, next: Next<this, 'dispose'>): void;
}

/**
 * Input for {@link WorkflowInternalsInterceptor.activate}
 */
export interface ActivateInput {
  activation: coresdk.workflow_activation.IWorkflowActivation;
  batchIndex: number;
}

/**
 * Input for {@link WorkflowInternalsInterceptor.dispose}
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DisposeInput {}

/**
 * Input for {@link WorkflowInternalsInterceptor.concludeActivation}
 */
export interface ConcludeActivationInput {
  commands: coresdk.workflow_commands.IWorkflowCommand[];
}

/**
 * Output for {@link WorkflowInternalsInterceptor.concludeActivation}
 */
export type ConcludeActivationOutput = ConcludeActivationInput;
