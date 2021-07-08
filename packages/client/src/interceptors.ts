/**
 * Definitions for Connection interceptors.
 *
 * @module
 */

import { Next, Headers } from '@temporalio/workflow';
import { temporal } from '@temporalio/proto';
import { CompiledWorkflowOptions } from './workflow-options';
import { TerminateWorkflowExecutionResponse, WorkflowExecution } from './types';

export { Next, Headers };

/** Input for WorkflowClientCallsInterceptor.start */
export interface WorkflowStartInput {
  /** Name of Workflow to start */
  readonly name: string;
  /** Workflow arguments */
  readonly args: unknown[];
  readonly headers: Headers;
  readonly options: CompiledWorkflowOptions;
}

/** Input for WorkflowClientCallsInterceptor.signal */
export interface WorkflowSignalInput {
  readonly signalName: string;
  readonly args: unknown[];
  readonly workflowExecution: WorkflowExecution;
}

/** Input for WorkflowClientCallsInterceptor.query */
export interface WorkflowQueryInput {
  readonly queryType: string;
  readonly args: unknown[];
  readonly workflowExecution: WorkflowExecution;
  readonly queryRejectCondition?: temporal.api.enums.v1.QueryRejectCondition;
}

/** Input for WorkflowClientCallsInterceptor.signal */
export interface WorkflowTerminateInput {
  readonly workflowExecution: WorkflowExecution;
  readonly reason?: string;
  readonly details?: unknown[];
}
/**
 * Implement any of these methods to intercept WorkflowClient outbound calls
 */
export interface WorkflowClientCallsInterceptor {
  start?: (input: WorkflowStartInput, next: Next<this, 'start'>) => Promise<string /* runId */>;
  signal?: (input: WorkflowSignalInput, next: Next<this, 'signal'>) => Promise<void>;
  query?: (input: WorkflowQueryInput, next: Next<this, 'query'>) => Promise<unknown>;
  terminate?: (
    input: WorkflowTerminateInput,
    next: Next<this, 'terminate'>
  ) => Promise<TerminateWorkflowExecutionResponse>;
}

interface WorkflowClientCallsInterceptorFactoryInput {
  workflowId: string;
  runId?: string;
}

/**
 * A function that takes {@link CompiledWorkflowOptions} and returns an interceptor
 */
export interface WorkflowClientCallsInterceptorFactory {
  (input: WorkflowClientCallsInterceptorFactoryInput): WorkflowClientCallsInterceptor;
}

/**
 * A mapping of interceptor type of a list of factory functions
 */
export interface WorkflowClientInterceptors {
  calls?: WorkflowClientCallsInterceptorFactory[];
}
