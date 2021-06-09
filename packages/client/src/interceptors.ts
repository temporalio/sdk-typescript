/**
 * Definitions for Connection interceptors.
 *
 * @module
 */

import { Next, Headers } from '@temporalio/workflow';
import { CompiledWorkflowOptions } from './workflow-options';

/** Input for WorkflowClientCallsInterceptor.start */
export interface WorkflowStartInput {
  /** Name of Workflow to start */
  readonly name: string;
  /** Workflow arguments */
  readonly args: unknown[];
  readonly headers: Headers;
}

/**
 * Implement any of these methods to intercept WorkflowClient outbound calls
 */
export interface WorkflowClientCallsInterceptor {
  start?: (input: WorkflowStartInput, next: Next<WorkflowClientCallsInterceptor, 'start'>) => Promise<unknown>;
}

/**
 * A function that takes {@link CompiledWorkflowOptions} and returns an interceptor
 */
export interface WorkflowClientCallsInterceptorFactory {
  (options: CompiledWorkflowOptions): WorkflowClientCallsInterceptor;
}

/**
 * A mapping of interceptor type of a list of factory functions
 */
export interface ConnectionInterceptors {
  workflowClient?: WorkflowClientCallsInterceptorFactory[];
}
