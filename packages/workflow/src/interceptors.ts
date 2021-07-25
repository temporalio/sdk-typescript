/**
 * Type definitions and generic helpers for interceptors.
 *
 * The Workflow specific interceptors are defined here.
 *
 * @module
 */

import { ChildWorkflowOptions, ContinueAsNewOptions } from './interfaces';
import { ActivityOptions, Headers, Next } from '@temporalio/common';

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
   * Called when Workflow main method is called
   *
   * @return result of the workflow execution
   */
  execute?: (input: WorkflowInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>) => Promise<unknown>;

  /** Called when signal is delivered to a Workflow execution */
  handleSignal?: (input: SignalInput, next: Next<WorkflowInboundCallsInterceptor, 'handleSignal'>) => Promise<void>;

  /**
   * Called when a Workflow is queried
   *
   * @return result of the query
   */
  handleQuery?: (input: QueryInput, next: Next<WorkflowInboundCallsInterceptor, 'handleQuery'>) => Promise<unknown>;
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

/**
 * Workflow interceptor modules should export an interceptors variable conforming to this interface
 *
 * @example
 *
 * ```ts
 * export const interceptors: WorkflowInterceptors = {
 *   inbound: [],  // Populate with list of interceptor implementations
 *   outbound: [], // Populate with list of interceptor implementations
 * };
 * ```
 */
export interface WorkflowInterceptors {
  inbound: WorkflowInboundCallsInterceptor[];
  outbound: WorkflowOutboundCallsInterceptor[];
}
