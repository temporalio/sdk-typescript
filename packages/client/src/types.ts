import type * as grpc from '@grpc/grpc-js';
import type { SearchAttributes } from '@temporalio/common';
import * as proto from '@temporalio/proto';
import { Replace } from '@temporalio/common/lib/type-helpers';

export interface WorkflowExecution {
  workflowId: string;
  runId?: string;
}
export type StartWorkflowExecutionRequest = proto.temporal.api.workflowservice.v1.IStartWorkflowExecutionRequest;
export type GetWorkflowExecutionHistoryRequest =
  proto.temporal.api.workflowservice.v1.IGetWorkflowExecutionHistoryRequest;
export type DescribeWorkflowExecutionResponse =
  proto.temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse;
export type RawWorkflowExecutionInfo = proto.temporal.api.workflow.v1.IWorkflowExecutionInfo;
export type TerminateWorkflowExecutionResponse =
  proto.temporal.api.workflowservice.v1.ITerminateWorkflowExecutionResponse;
export type RequestCancelWorkflowExecutionResponse =
  proto.temporal.api.workflowservice.v1.IRequestCancelWorkflowExecutionResponse;

export type WorkflowExecutionStatusName =
  | 'UNSPECIFIED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TERMINATED'
  | 'CONTINUED_AS_NEW'
  | 'TIMED_OUT'
  | 'UNKNOWN'; // UNKNOWN is reserved for future enum values

export interface WorkflowExecutionInfo {
  type: string;
  workflowId: string;
  runId: string;
  taskQueue: string;
  status: { code: proto.temporal.api.enums.v1.WorkflowExecutionStatus; name: WorkflowExecutionStatusName };
  historyLength: number;
  startTime: Date;
  executionTime?: Date;
  closeTime?: Date;
  memo?: Record<string, unknown>;
  searchAttributes: SearchAttributes;
  parentExecution?: Required<proto.temporal.api.common.v1.IWorkflowExecution>;
  raw: RawWorkflowExecutionInfo;
}

export type WorkflowExecutionDescription = Replace<
  WorkflowExecutionInfo,
  {
    raw: DescribeWorkflowExecutionResponse;
  }
>;

export type WorkflowService = proto.temporal.api.workflowservice.v1.WorkflowService;
export const { WorkflowService } = proto.temporal.api.workflowservice.v1;
export type OperatorService = proto.temporal.api.operatorservice.v1.OperatorService;
export const { OperatorService } = proto.temporal.api.operatorservice.v1;
export type HealthService = proto.grpc.health.v1.Health;
export const { Health: HealthService } = proto.grpc.health.v1;

/**
 * Mapping of string to valid gRPC metadata value
 */
export type Metadata = Record<string, grpc.MetadataValue>;

/**
 * User defined context for gRPC client calls
 */
export interface CallContext {
  /**
   * {@link Deadline | https://grpc.io/blog/deadlines/} for gRPC client calls
   */
  deadline?: number | Date;
  /**
   * Metadata to set on gRPC requests
   */
  metadata?: Metadata;
}

/**
 * Connection interface used by high level SDK clients.
 *
 * NOTE: Currently the SDK only supports grpc-js based connection but in the future
 * we might support grpc-web and native Rust connections.
 */
export interface ConnectionLike {
  workflowService: WorkflowService;
  close(): Promise<void>;
  ensureConnected(): Promise<void>;
  /**
   * Set the deadline for any service requests executed in `fn`'s scope.
   */
  withDeadline<R>(deadline: number | Date, fn: () => Promise<R>): Promise<R>;

  /**
   * Set metadata for any service requests executed in `fn`'s scope.
   *
   * @returns returned value of `fn`
   */
  withMetadata<R>(metadata: Metadata, fn: () => Promise<R>): Promise<R>;
}
