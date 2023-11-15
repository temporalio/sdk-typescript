/**
 * Definitions for Activity interceptors.
 *
 * (The Worker also accepts Workflow interceptors but those are passed as module names)
 *
 * @module
 */

import { Context as ActivityContext } from '@temporalio/activity';
import { Headers, Next } from '@temporalio/common';

export { Next, Headers };

/** Input for ActivityInboundCallsInterceptor.execute */
export interface ActivityExecuteInput {
  readonly args: unknown[];
  readonly headers: Headers;
}

/**
 * Implement any of these methods to intercept Activity inbound calls
 */
export interface ActivityInboundCallsInterceptor {
  /**
   * Called when Activity function is executed
   *
   * @return result of Activity function
   */
  execute?: (input: ActivityExecuteInput, next: Next<this, 'execute'>) => Promise<unknown>;
}

/**
 * A function that takes Activity Context and returns an interceptor
 *
 * @deprecated Use {@link ActivityInterceptorsFactory} instead
 */
export interface ActivityInboundCallsInterceptorFactory {
  (ctx: ActivityContext): ActivityInboundCallsInterceptor;
}

/** Input for ActivityOutboundCallsInterceptor.getLogAttributes */
export type GetLogAttributesInput = Record<string, unknown>;

/**
 * Implement any of these methods to intercept Activity outbound calls
 */
export interface ActivityOutboundCallsInterceptor {
  /**
   * Called on each invocation of the `activity.log` methods.
   *
   * The attributes returned in this call are attached to every log message.
   */
  getLogAttributes?: (input: GetLogAttributesInput, next: Next<this, 'getLogAttributes'>) => Record<string, unknown>;
}

export interface ActivityInterceptors {
  inbound?: ActivityInboundCallsInterceptor;
  outbound?: ActivityOutboundCallsInterceptor;
}

/**
 * A function that takes Activity Context and returns an interceptor
 */
export type ActivityInterceptorsFactory = (ctx: ActivityContext) => ActivityInterceptors;

/**
 * Structure for passing in Worker interceptors via {@link WorkerOptions}
 */
export interface WorkerInterceptors {
  /**
   * List of factory functions that instanciate {@link ActivityInboundCallsInterceptor}s and
   * {@link ActivityOutboundCallsInterceptor}s.
   */
  activity?: ActivityInterceptorsFactory[];
  /**
   * List of factory functions returning {@link ActivityInboundCallsInterceptor}s. If both `activity` and
   * `activityInbound` is supplied, then entries from `activityInbound` will be prepended to inbound interceptors
   * instanciated from `activity`.
   *
   * @deprecated Use {@link WorkerInterceptors.activity} instead.
   */
  activityInbound?: ActivityInboundCallsInterceptorFactory[]; // eslint-disable-line deprecation/deprecation
  /**
   * List of modules to search for Workflow interceptors in
   * - Modules should export an `interceptors` variable of type {@link WorkflowInterceptorsFactory}
   * - Workflow interceptors run in the Workflow isolate
   *
   * **NOTE**: This option is not used if Worker is provided with pre-built bundle ({@link WorkerOptions.workflowBundle}).
   */
  workflowModules?: string[];
}

export type CompiledWorkerInterceptors = Required<Pick<WorkerInterceptors, 'activity' | 'workflowModules'>>;
