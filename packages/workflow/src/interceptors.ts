/**
 * Type definitions and generic helpers for interceptors.
 *
 * The Workflow specific interceptors are defined here.
 *
 * @module
 */

import { ActivityOptions, Headers, LocalActivityOptions, Next, Timestamp, WorkflowExecution } from '@temporalio/common';
import type { coresdk } from '@temporalio/proto';
import { ChildWorkflowOptionsWithDefaults, ContinueAsNewOptions } from './interfaces';

export { Next, Headers };

/** Input for WorkflowInboundCallsInterceptor.execute */
export interface WorkflowExecuteInput {
  readonly args: unknown[];
  readonly headers: Headers;
}

/** Input for WorkflowInboundCallsInterceptor.handleUpdate and
 * WorkflowInboundCallsInterceptor.validateUpdate */
export interface UpdateInput {
  readonly updateId: string;
  readonly name: string;
  readonly args: unknown[];
  readonly headers: Headers;
}

/** Input for WorkflowInboundCallsInterceptor.handleSignal */
export interface SignalInput {
  readonly signalName: string;
  readonly args: unknown[];
  readonly headers: Headers;
}

/** Input for WorkflowInboundCallsInterceptor.handleQuery */
export interface QueryInput {
  readonly queryId: string;
  readonly queryName: string;
  readonly args: unknown[];
  readonly headers: Headers;
}

/**
 * Implement any of these methods to intercept Workflow inbound calls like execution, and signal and query handling.
 */
export interface WorkflowInboundCallsInterceptor {
  /**
   * Called when Workflow execute method is called
   *
   * @return result of the Workflow execution
   */
  execute?: (input: WorkflowExecuteInput, next: Next<this, 'execute'>) => Promise<unknown>;

  /** Called when Update handler is called
   *
   * @return result of the Update
   */
  handleUpdate?: (input: UpdateInput, next: Next<this, 'handleUpdate'>) => Promise<unknown>;

  /** Called when update validator called */
  validateUpdate?: (input: UpdateInput, next: Next<this, 'validateUpdate'>) => void;

  /** Called when signal is delivered to a Workflow execution */
  handleSignal?: (input: SignalInput, next: Next<this, 'handleSignal'>) => Promise<void>;

  /**
   * Called when a Workflow is queried
   *
   * @return result of the query
   */
  handleQuery?: (input: QueryInput, next: Next<this, 'handleQuery'>) => Promise<unknown>;
}

/** Input for WorkflowOutboundCallsInterceptor.scheduleActivity */
export interface ActivityInput {
  readonly activityType: string;
  readonly args: unknown[];
  readonly options: ActivityOptions;
  readonly headers: Headers;
  readonly seq: number;
}

/** Input for WorkflowOutboundCallsInterceptor.scheduleLocalActivity */
export interface LocalActivityInput {
  readonly activityType: string;
  readonly args: unknown[];
  readonly options: LocalActivityOptions;
  readonly headers: Headers;
  readonly seq: number;
  readonly originalScheduleTime?: Timestamp;
  readonly attempt: number;
}

/** Input for WorkflowOutboundCallsInterceptor.startChildWorkflowExecution */
export interface StartChildWorkflowExecutionInput {
  readonly workflowType: string;
  readonly options: ChildWorkflowOptionsWithDefaults;
  readonly headers: Headers;
  readonly seq: number;
}

/** Input for WorkflowOutboundCallsInterceptor.startTimer */
export interface TimerInput {
  readonly durationMs: number;
  readonly seq: number;
}

/**
 * Same as ContinueAsNewOptions but workflowType must be defined
 */
export type ContinueAsNewInputOptions = ContinueAsNewOptions & Required<Pick<ContinueAsNewOptions, 'workflowType'>>;

/** Input for WorkflowOutboundCallsInterceptor.continueAsNew */
export interface ContinueAsNewInput {
  readonly args: unknown[];
  readonly headers: Headers;
  readonly options: ContinueAsNewInputOptions;
}

/** Input for WorkflowOutboundCallsInterceptor.signalWorkflow */
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

/** Input for WorkflowOutboundCallsInterceptor.getLogAttributes */
export type GetLogAttributesInput = Record<string, unknown>;

/**
 * Implement any of these methods to intercept Workflow code calls to the Temporal APIs, like scheduling an activity and starting a timer
 */
export interface WorkflowOutboundCallsInterceptor {
  /**
   * Called when Workflow schedules an Activity
   *
   * @return result of the activity execution
   */
  scheduleActivity?: (input: ActivityInput, next: Next<this, 'scheduleActivity'>) => Promise<unknown>;

  /**
   * Called when Workflow schedules a local Activity
   *
   * @return result of the activity execution
   */
  scheduleLocalActivity?: (input: LocalActivityInput, next: Next<this, 'scheduleLocalActivity'>) => Promise<unknown>;

  /**
   * Called when Workflow starts a timer
   */
  startTimer?: (input: TimerInput, next: Next<this, 'startTimer'>) => Promise<void>;

  /**
   * Called when Workflow calls continueAsNew
   */
  continueAsNew?: (input: ContinueAsNewInput, next: Next<this, 'continueAsNew'>) => Promise<never>;

  /**
   * Called when Workflow signals a child or external Workflow
   */
  signalWorkflow?: (input: SignalWorkflowInput, next: Next<this, 'signalWorkflow'>) => Promise<void>;

  /**
   * Called when Workflow starts a child workflow execution, the interceptor function returns 2 promises:
   *
   * - The first resolves with the `runId` when the child workflow has started or rejects if failed to start.
   * - The second resolves with the workflow result when the child workflow completes or rejects on failure.
   */
  startChildWorkflowExecution?: (
    input: StartChildWorkflowExecutionInput,
    next: Next<this, 'startChildWorkflowExecution'>
  ) => Promise<[Promise<string>, Promise<unknown>]>;

  /**
   * Called on each invocation of the `workflow.log` methods.
   *
   * The attributes returned in this call are attached to every log message.
   */
  getLogAttributes?: (input: GetLogAttributesInput, next: Next<this, 'getLogAttributes'>) => Record<string, unknown>;
}

/** Input for WorkflowInternalsInterceptor.concludeActivation */
export interface ConcludeActivationInput {
  commands: coresdk.workflow_commands.IWorkflowCommand[];
}

/** Output for WorkflowInternalsInterceptor.concludeActivation */
export type ConcludeActivationOutput = ConcludeActivationInput;

/** Input for WorkflowInternalsInterceptor.activate */
export interface ActivateInput {
  activation: coresdk.workflow_activation.IWorkflowActivation;
  batchIndex: number;
}

/** Input for WorkflowInternalsInterceptor.dispose */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DisposeInput {}

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
 * A mapping from interceptor type to an optional list of interceptor implementations
 */
export interface WorkflowInterceptors {
  inbound?: WorkflowInboundCallsInterceptor[];
  outbound?: WorkflowOutboundCallsInterceptor[];
  internals?: WorkflowInternalsInterceptor[];
}

/**
 * A function that returns {@link WorkflowInterceptors} and takes no arguments.
 *
 * Workflow interceptor modules should export an `interceptors` function of this type.
 *
 * @example
 *
 * ```ts
 * export function interceptors(): WorkflowInterceptors {
 *   return {
 *     inbound: [],   // Populate with list of interceptor implementations
 *     outbound: [],  // Populate with list of interceptor implementations
 *     internals: [], // Populate with list of interceptor implementations
 *   };
 * }
 * ```
 */
export type WorkflowInterceptorsFactory = () => WorkflowInterceptors;
