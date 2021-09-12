/**
 * Type definitions and generic helpers for interceptors.
 *
 * The Workflow specific interceptors are defined here.
 *
 * @module
 */

import { ActivityOptions, WorkflowExecution, Headers, Next } from '@temporalio/common';
import { coresdk } from '@temporalio/proto/lib/coresdk';
import { ChildWorkflowOptions, ContinueAsNewOptions } from './interfaces';

export { Next, Headers };

/** Input for WorkflowInboundCallsInterceptor.execute */
export interface WorkflowInput {
  readonly args: unknown[];
  readonly headers: Headers;
}

/** Input for WorkflowInboundCallsInterceptor.handleSignal */
export interface SignalInput {
  readonly signalName: string;
  readonly args: unknown[];
}

/** Input for WorkflowInboundCallsInterceptor.handleQuery */
export interface QueryInput {
  readonly queryId: string;
  readonly queryName: string;
  readonly args: unknown[];
}

/**
 * Implement any of these methods to intercept Workflow inbound calls like execution, and signal and query handling.
 */
export interface WorkflowInboundCallsInterceptor {
  /**
   * Called when Workflow execute method is called
   *
   * TODO: intercept creation too and move args there?
   *
   * @return result of the workflow execution
   */
  execute?: (input: WorkflowInput, next: Next<this, 'execute'>) => Promise<unknown>;

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

/** Input for WorkflowOutboundCallsInterceptor.startChildWorkflowExecution */
export interface StartChildWorkflowExecutionInput {
  readonly workflowType: string;
  readonly args: unknown[];
  readonly options: ChildWorkflowOptions;
  readonly headers: Headers;
  readonly seq: number;
}

/** Input for WorkflowOutboundCallsInterceptor.startTimer */
export interface TimerInput {
  readonly durationMs: number;
  readonly seq: number;
}

/** Input for WorkflowOutboundCallsInterceptor.continueAsNew */
export interface ContinueAsNewInput {
  args: unknown[];
  headers: Headers;
  options: ContinueAsNewOptions;
}

/** Input for WorkflowOutboundCallsInterceptor.signalWorkflow */
export interface SignalWorkflowInput {
  seq: number;
  signalName: string;
  args: unknown[];
  target:
    | {
        type: 'external';
        workflowExecution: WorkflowExecution;
      }
    | {
        type: 'child';
        childWorkflowId: string;
      };
}

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
}

/** Input for WorkflowInternalsInterceptor.concludeActivation */
export interface ConcludeActivationInput {
  commands: coresdk.workflow_commands.IWorkflowCommand[];
}

/** Output for WorkflowInternalsInterceptor.concludeActivation */
export type ConcludeActivationOutput = ConcludeActivationInput;

/** Input for WorkflowInternalsInterceptor.activate */
export interface ActivateInput {
  activation: coresdk.workflow_activation.IWFActivation;
  jobIndex: number;
}

/**
 * Interceptor for the internals of the Workflow runtime.
 *
 * Use to manipulate or trace Workflow activations.
 */
export interface WorkflowInternalsInterceptor {
  /**
   * Called when the Workflow runtime runs a WFActivationJob.
   *
   * Returns a `boolean` indicating whether this job was processed or not
   */
  activate?(input: ActivateInput, next: Next<this, 'activate'>): Promise<boolean>;
  /**
   * Called after all `WFActivationJob`s have been proccesed for an activation.
   *
   * Can manipulate the commands generated by the Workflow
   */
  concludeActivation?(input: ConcludeActivationInput, next: Next<this, 'concludeActivation'>): ConcludeActivationOutput;
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
