/**
 * Definitions for Connection interceptors.
 *
 * @module
 */

import { Next, Headers } from '@temporalio/workflow';
import { temporal } from '@temporalio/proto';
import { CompiledWorkflowOptions } from './workflow-options';
import { RequestCancelWorkflowExecutionResponse, TerminateWorkflowExecutionResponse, WorkflowExecution } from './types';

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

/** Input for WorkflowClientCallsInterceptor.signalWithStart */
export interface WorkflowSignalWithStartInput {
  readonly workflowName: string;
  readonly workflowArgs: unknown[];
  readonly signalName: string;
  readonly signalArgs: unknown[];
  readonly headers: Headers;
  readonly options: CompiledWorkflowOptions;
}

/** Input for WorkflowClientCallsInterceptor.query */
export interface WorkflowQueryInput {
  readonly queryType: string;
  readonly args: unknown[];
  readonly workflowExecution: WorkflowExecution;
  readonly queryRejectCondition?: temporal.api.enums.v1.QueryRejectCondition;
}

/** Input for WorkflowClientCallsInterceptor.terminate */
export interface WorkflowTerminateInput {
  readonly workflowExecution: WorkflowExecution;
  readonly reason?: string;
  readonly details?: unknown[];
}

/** Input for WorkflowClientCallsInterceptor.cancel */
export interface WorkflowCancelInput {
  readonly workflowExecution: WorkflowExecution;
}

/**
 * Implement any of these methods to intercept WorkflowClient outbound calls
 */
export interface WorkflowClientCallsInterceptor {
  /**
   * Intercept a service call to startWorkflowExecution
   *
   * If you implement this method,
   * {@link signalWithStart} most likely needs to be implemented too
   */
  start?: (input: WorkflowStartInput, next: Next<this, 'start'>) => Promise<string /* runId */>;
  /**
   * Intercept a service call to signalWorkflowExecution
   *
   * If you implement this method,
   * {@link signalWithStart} most likely needs to be implemented too
   */
  signal?: (input: WorkflowSignalInput, next: Next<this, 'signal'>) => Promise<void>;
  /**
   * Intercept a service call to signalWithStartWorkflowExecution
   */
  signalWithStart?: (input: WorkflowSignalWithStartInput, next: Next<this, 'signalWithStart'>) => Promise<string>;
  /**
   * Intercept a service call to queryWorkflow
   */
  query?: (input: WorkflowQueryInput, next: Next<this, 'query'>) => Promise<unknown>;
  /**
   * Intercept a service call to terminateWorkflowExecution
   */
  terminate?: (
    input: WorkflowTerminateInput,
    next: Next<this, 'terminate'>
  ) => Promise<TerminateWorkflowExecutionResponse>;
  /**
   * Intercept a service call to requestCancelWorkflowExecution
   */
  cancel?: (input: WorkflowCancelInput, next: Next<this, 'cancel'>) => Promise<RequestCancelWorkflowExecutionResponse>;
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
