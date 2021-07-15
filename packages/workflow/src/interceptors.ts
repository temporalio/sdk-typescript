/**
 * Type definitions and generic helpers for interceptors.
 *
 * The Workflow specific interceptors are defined here.
 *
 * @module
 */

import { coresdk } from '@temporalio/proto';
import { ActivityOptions, ContinueAsNewOptions } from './interfaces';
import { AnyFunc, OmitLastParam } from './type-helpers';

/**
 * Type of the next function for a given interceptor function
 *
 * Called from an interceptor to continue the interception chain
 */
export type Next<IF, FN extends keyof IF> = Required<IF>[FN] extends AnyFunc ? OmitLastParam<Required<IF>[FN]> : never;

/** Headers are just a mapping of header name to Payload */
export type Headers = Map<string, coresdk.common.IPayload>;

/**
 * Composes all interceptor methods into a single function
 *
 * @param interceptors a list of interceptors
 * @param method the name of the interceptor method to compose
 * @param next the original function to be executed at the end of the interception chain
 */
export function composeInterceptors<I, M extends keyof I>(interceptors: I[], method: M, next: Next<I, M>): Next<I, M> {
  for (let i = interceptors.length - 1; i >= 0; --i) {
    const interceptor = interceptors[i];
    if (interceptor[method] !== undefined) {
      const prev = next;
      // We loose type safety here because Typescript can't deduce that interceptor[method] is a function that returns
      // the same type as Next<I, M>
      next = ((input: any) => (interceptor[method] as any)(input, prev)) as any;
    }
  }
  return next;
}

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
