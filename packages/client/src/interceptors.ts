/**
 * Definitions for Connection interceptors.
 *
 * @module
 */

import type { Duration, SearchAttributePair, TypedSearchAttributes } from '@temporalio/common';
import { Headers, Next } from '@temporalio/common';
import type { temporal } from '@temporalio/proto';
import type { NexusOperationHandle } from './nexus-client';
import type {
  NexusOperationExecutionCount,
  NexusOperationExecutionDescription,
  NexusOperationExecution,
  NexusOperationIdConflictPolicy,
  NexusOperationIdReusePolicy,
} from './nexus-types';
import type { CompiledScheduleOptions } from './schedule-types';
import type {
  DescribeWorkflowExecutionResponse,
  RequestCancelWorkflowExecutionResponse,
  TerminateWorkflowExecutionResponse,
  WorkflowExecution,
} from './types';
import type { CompiledWorkflowOptions, WorkflowUpdateOptions } from './workflow-options';

export { Headers, Next };

/** Input for WorkflowClientInterceptor.start */
export interface WorkflowStartInput {
  /** Name of Workflow to start */
  readonly workflowType: string;
  readonly headers: Headers;
  readonly options: CompiledWorkflowOptions;
}

/** Input for WorkflowClientInterceptor.update */
export interface WorkflowStartUpdateInput {
  readonly updateName: string;
  readonly args: unknown[];
  readonly workflowExecution: WorkflowExecution;
  readonly firstExecutionRunId?: string;
  readonly headers: Headers;
  readonly options: WorkflowUpdateOptions;
}

/** Output for WorkflowClientInterceptor.startWithDetails */
export interface WorkflowStartOutput {
  readonly runId: string;
  readonly eagerlyStarted: boolean;
}

/** Output for WorkflowClientInterceptor.startUpdate */
export interface WorkflowStartUpdateOutput {
  readonly updateId: string;
  readonly workflowRunId: string;
  readonly outcome?: temporal.api.update.v1.IOutcome;
}

/**
 * Input for WorkflowClientInterceptor.startUpdateWithStart
 */
export interface WorkflowStartUpdateWithStartInput {
  readonly workflowType: string;
  readonly workflowStartOptions: CompiledWorkflowOptions;
  readonly workflowStartHeaders: Headers;
  readonly updateName: string;
  readonly updateArgs: unknown[];
  readonly updateOptions: WorkflowUpdateOptions;
  readonly updateHeaders: Headers;
}

/**
 * Output for WorkflowClientInterceptor.startUpdateWithStart
 */
export interface WorkflowStartUpdateWithStartOutput {
  readonly workflowExecution: WorkflowExecution;
  readonly updateId: string;
  readonly updateOutcome?: temporal.api.update.v1.IOutcome;
}

/** Input for WorkflowClientInterceptor.signal */
export interface WorkflowSignalInput {
  readonly signalName: string;
  readonly args: unknown[];
  readonly workflowExecution: WorkflowExecution;
  readonly headers: Headers;
}

/** Input for WorkflowClientInterceptor.signalWithStart */
export interface WorkflowSignalWithStartInput {
  readonly workflowType: string;
  readonly signalName: string;
  readonly signalArgs: unknown[];
  readonly headers: Headers;
  readonly options: CompiledWorkflowOptions;
}

/** Input for WorkflowClientInterceptor.query */
export interface WorkflowQueryInput {
  readonly queryType: string;
  readonly args: unknown[];
  readonly workflowExecution: WorkflowExecution;
  readonly queryRejectCondition?: temporal.api.enums.v1.QueryRejectCondition;
  readonly headers: Headers;
}

/** Input for WorkflowClientInterceptor.terminate */
export interface WorkflowTerminateInput {
  readonly workflowExecution: WorkflowExecution;
  readonly reason?: string;
  readonly details?: unknown[];
  readonly firstExecutionRunId?: string;
}

/** Input for WorkflowClientInterceptor.cancel */
export interface WorkflowCancelInput {
  readonly workflowExecution: WorkflowExecution;
  readonly firstExecutionRunId?: string;
}

/** Input for WorkflowClientInterceptor.describe */
export interface WorkflowDescribeInput {
  readonly workflowExecution: WorkflowExecution;
}

/**
 * Implement any of these methods to intercept WorkflowClient outbound calls
 */
export interface WorkflowClientInterceptor {
  /**
   * Intercept a service call to startWorkflowExecution
   *
   * If you implement this method,
   * {@link signalWithStart} most likely needs to be implemented too
   *
   * @deprecated in favour of {@link startWithDetails}
   */
  start?: (input: WorkflowStartInput, next: Next<this, 'start'>) => Promise<string /* runId */>;

  /**
   * Intercept a service call to startWorkflowExecution
   *
   * This method returns start details via {@link WorkflowStartOutput}.
   *
   * If you implement this method,
   * {@link signalWithStart} most likely needs to be implemented too
   */
  startWithDetails?: (input: WorkflowStartInput, next: Next<this, 'startWithDetails'>) => Promise<WorkflowStartOutput>;

  /**
   * Intercept a service call to updateWorkflowExecution
   */
  startUpdate?: (
    input: WorkflowStartUpdateInput,
    next: Next<this, 'startUpdate'>
  ) => Promise<WorkflowStartUpdateOutput>;
  /**
   * Intercept a service call to startUpdateWithStart
   */
  startUpdateWithStart?: (
    input: WorkflowStartUpdateWithStartInput,
    next: Next<this, 'startUpdateWithStart'>
  ) => Promise<WorkflowStartUpdateWithStartOutput>;
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
  /**
   * Intercept a service call to describeWorkflowExecution
   */
  describe?: (input: WorkflowDescribeInput, next: Next<this, 'describe'>) => Promise<DescribeWorkflowExecutionResponse>;
}

/** @deprecated: Use WorkflowClientInterceptor instead */
export type WorkflowClientCallsInterceptor = WorkflowClientInterceptor;

/** @deprecated */
export interface WorkflowClientCallsInterceptorFactoryInput {
  workflowId: string;
  runId?: string;
}

/**
 * A function that takes {@link CompiledWorkflowOptions} and returns an interceptor
 *
 * @deprecated: Please define interceptors directly, without factory
 */
export interface WorkflowClientCallsInterceptorFactory {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  (input: WorkflowClientCallsInterceptorFactoryInput): WorkflowClientCallsInterceptor;
}

/**
 * A mapping of interceptor type of a list of factory functions
 *
 * @deprecated: Please define interceptors directly, without factory
 */
export interface WorkflowClientInterceptors {
  /** @deprecated */
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  calls?: WorkflowClientCallsInterceptorFactory[];
}

/**
 * Implement any of these methods to intercept ScheduleClient outbound calls
 */
export interface ScheduleClientInterceptor {
  /**
   * Intercept a service call to CreateSchedule
   */
  create?: (input: CreateScheduleInput, next: Next<this, 'create'>) => Promise<CreateScheduleOutput>;
}

/**
 * Input for {@link ScheduleClientInterceptor.create}
 */
export interface CreateScheduleInput {
  readonly headers: Headers;
  readonly options: CompiledScheduleOptions;
}

export type CreateScheduleOutput = {
  readonly conflictToken: Uint8Array;
};

/**
 * Implement any of these methods to intercept NexusClient outbound calls.
 */
export interface NexusClientInterceptor {
  /** Intercept a call to {@link NexusServiceClient.startOperation}. */
  startOperation?: (
    input: StartNexusOperationInput,
    next: Next<this, 'startOperation'>
  ) => Promise<NexusOperationHandle<unknown>>;

  /** Intercept {@link NexusOperationHandle.result}. */
  getResult?: (input: GetNexusOperationResultInput, next: Next<this, 'getResult'>) => Promise<unknown>;

  /** Intercept {@link NexusOperationHandle.describe}. */
  describe?: (
    input: DescribeNexusOperationInput,
    next: Next<this, 'describe'>
  ) => Promise<NexusOperationExecutionDescription>;

  /** Intercept {@link NexusOperationHandle.cancel}. */
  cancel?: (input: CancelNexusOperationInput, next: Next<this, 'cancel'>) => Promise<void>;

  /** Intercept {@link NexusOperationHandle.terminate}. */
  terminate?: (input: TerminateNexusOperationInput, next: Next<this, 'terminate'>) => Promise<void>;

  /** Intercept {@link NexusClient.list}. */
  list?: (input: ListNexusOperationsInput, next: Next<this, 'list'>) => AsyncIterable<NexusOperationExecution>;

  /** Intercept {@link NexusClient.count}. */
  count?: (input: CountNexusOperationsInput, next: Next<this, 'count'>) => Promise<NexusOperationExecutionCount>;
}

/** Input for {@link NexusClientInterceptor.startOperation}. */
export interface StartNexusOperationInput {
  readonly endpoint: string;
  readonly service: string;
  readonly operation: string;
  readonly id: string;
  readonly arg: unknown;
  readonly scheduleToCloseTimeout?: Duration;
  readonly summary?: string;
  readonly idReusePolicy?: NexusOperationIdReusePolicy;
  readonly idConflictPolicy?: NexusOperationIdConflictPolicy;
  readonly searchAttributes?: SearchAttributePair[] | TypedSearchAttributes;
  readonly headers?: Record<string, string>;
}

/** Input for {@link NexusClientInterceptor.getResult}. */
export interface GetNexusOperationResultInput {
  readonly operationId: string;
  readonly runId?: string;
}

/** Input for {@link NexusClientInterceptor.describe}. */
export interface DescribeNexusOperationInput {
  readonly operationId: string;
  readonly runId?: string;
  readonly longPollToken?: Uint8Array;
}

/** Input for {@link NexusClientInterceptor.cancel}. */
export interface CancelNexusOperationInput {
  readonly operationId: string;
  readonly runId?: string;
  readonly reason?: string;
}

/** Input for {@link NexusClientInterceptor.terminate}. */
export interface TerminateNexusOperationInput {
  readonly operationId: string;
  readonly runId?: string;
  readonly reason?: string;
}

/** Input for {@link NexusClientInterceptor.list}. */
export interface ListNexusOperationsInput {
  readonly query?: string;
  readonly pageSize?: number;
}

/** Input for {@link NexusClientInterceptor.count}. */
export interface CountNexusOperationsInput {
  readonly query?: string;
}

/**
 * Interceptors for any high-level SDK client.
 */
export interface ClientInterceptors {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  workflow?: WorkflowClientInterceptors | WorkflowClientInterceptor[];

  schedule?: ScheduleClientInterceptor[];

  nexus?: NexusClientInterceptor[];
}
