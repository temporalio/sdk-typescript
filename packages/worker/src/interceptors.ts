/**
 * Definitions for Activity interceptors.
 *
 * (The Worker also accepts Workflow interceptors but those are passed as module names)
 *
 * @module
 */

import { Next, Headers } from '@temporalio/common';
import { Context as ActivityContext } from '@temporalio/activity';

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
  execute?: (input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>) => Promise<unknown>;
}

/**
 * A function that takes Activity Context and returns an interceptor
 */
export interface ActivityInboundCallsInterceptorFactory {
  (ctx: ActivityContext): ActivityInboundCallsInterceptor;
}

/**
 * Structure for passing in Worker interceptors via {@link WorkerOptions}
 */
export interface WorkerInterceptors {
  /**
   * List of factory functions returning {@link ActivityInboundCallsInterceptor}s
   */
  activityInbound?: ActivityInboundCallsInterceptorFactory[];
  /**
   * List of modules to search for Workflow interceptors in {@link WorkerOptions.workflowsPath}
   * - Modules should export an `interceptors` variable of type {@link WorkflowInterceptors}
   * - Workflow interceptors run in in the Workflow isolate
   */
  workflowModules?: string[];
}
