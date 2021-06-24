/**
 * Definitions for Connection interceptors.
 *
 * @module
 */

import { Next, Headers } from '@temporalio/workflow';
import { temporal } from '@temporalio/proto';
import { CompiledWorkflowOptions } from './workflow-options';
import { TerminateWorkflowExecutionResponse } from './types';

export { Next, Headers };

/** Input for WorkflowClientCallsInterceptor.start */
export interface WorkflowStartInput {
  /** Name of Workflow to start */
  readonly name: string;
  /** Workflow arguments */
  readonly args: unknown[];
  readonly headers: Headers;
}

/** Input for WorkflowClientCallsInterceptor.signal */
export interface WorkflowSignalInput {
  readonly signalName: string;
  readonly args: unknown[];
  readonly namespace: string;
  readonly workflowExecution: temporal.api.common.v1.IWorkflowExecution;
}

/** Input for WorkflowClientCallsInterceptor.query */
export interface WorkflowQueryInput {
  readonly queryType: string;
  readonly args: unknown[];
  readonly namespace: string;
  readonly workflowExecution: temporal.api.common.v1.IWorkflowExecution;
}

/** Input for WorkflowClientCallsInterceptor.signal */
export interface WorkflowTerminateInput {
  readonly workflowExecution: temporal.api.common.v1.IWorkflowExecution;
  readonly reason?: string;
  readonly details?: unknown[];
}
/**
 * Implement any of these methods to intercept WorkflowClient outbound calls
 */
export interface WorkflowClientCallsInterceptor {
  start?: (input: WorkflowStartInput, next: Next<WorkflowClientCallsInterceptor, 'start'>) => Promise<unknown>;
  signal?: (input: WorkflowSignalInput, next: Next<WorkflowClientCallsInterceptor, 'signal'>) => Promise<void>;
  query?: (input: WorkflowQueryInput, next: Next<WorkflowClientCallsInterceptor, 'query'>) => Promise<unknown>;
  terminate?: (
    input: WorkflowTerminateInput,
    next: Next<WorkflowClientCallsInterceptor, 'terminate'>
  ) => Promise<TerminateWorkflowExecutionResponse>;
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
