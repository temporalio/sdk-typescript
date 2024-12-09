import type * as grpc from '@grpc/grpc-js';
import type { SearchAttributes, SearchAttributeValue } from '@temporalio/common';
import { makeProtoEnumConverters } from '@temporalio/common/lib/internal-workflow';
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
  /**
￼   * Size of Workflow history in bytes.
￼   *
￼   * This value is only available in server versions >= 1.20
￼   */
  historySize?: number;
  startTime: Date;
  executionTime?: Date;
  closeTime?: Date;
  memo?: Record<string, unknown>;
  searchAttributes: SearchAttributes;
  parentExecution?: Required<proto.temporal.api.common.v1.IWorkflowExecution>;
  raw: RawWorkflowExecutionInfo;
}

export interface CountWorkflowExecution {
  count: number;
  groups: {
    count: number;
    groupValues: SearchAttributeValue[];
  }[];
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

  abortSignal?: AbortSignal;
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
   * Set a deadline for any service requests executed in `fn`'s scope.
   *
   * The deadline is a point in time after which any pending gRPC request will be considered as failed;
   * this will locally result in the request call throwing a {@link grpc.ServiceError|ServiceError}
   * with code {@link grpc.status.DEADLINE_EXCEEDED|DEADLINE_EXCEEDED}; see {@link isGrpcDeadlineError}.
   *
   * It is stronly recommended to explicitly set deadlines. If no deadline is set, then it is
   * possible for the client to end up waiting forever for a response.
   *
   * This method is only a convenience wrapper around {@link Connection.withDeadline}.
   *
   * @param deadline a point in time after which the request will be considered as failed; either a
   *                 Date object, or a number of milliseconds since the Unix epoch (UTC).
   * @returns the value returned from `fn`
   *
   * @see https://grpc.io/docs/guides/deadlines/
   */
  withDeadline<R>(deadline: number | Date, fn: () => Promise<R>): Promise<R>;

  /**
   * Set metadata for any service requests executed in `fn`'s scope.
   *
   * @returns returned value of `fn`
   */
  withMetadata<R>(metadata: Metadata, fn: () => Promise<R>): Promise<R>;

  /**
   * Set an {@link AbortSignal} that, when aborted, cancels any ongoing service requests executed in
   * `fn`'s scope. This will locally result in the request call throwing a {@link grpc.ServiceError|ServiceError}
   * with code {@link grpc.status.CANCELLED|CANCELLED}; see {@link isGrpcCancelledError}.
   *
   * @returns value returned from `fn`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
   */
  withAbortSignal<R>(abortSignal: AbortSignal, fn: () => Promise<R>): Promise<R>;
}

export const QueryRejectCondition = {
  NONE: 'NONE',
  NOT_OPEN: 'NOT_OPEN',
  NOT_COMPLETED_CLEANLY: 'NOT_COMPLETED_CLEANLY',

  /** @deprecated Use {@link NONE} instead. */
  QUERY_REJECT_CONDITION_NONE: 'NONE', // eslint-disable-line deprecation/deprecation

  /** @deprecated Use {@link NOT_OPEN} instead. */
  QUERY_REJECT_CONDITION_NOT_OPEN: 'NOT_OPEN', // eslint-disable-line deprecation/deprecation

  /** @deprecated Use {@link NOT_COMPLETED_CLEANLY} instead. */
  QUERY_REJECT_CONDITION_NOT_COMPLETED_CLEANLY: 'NOT_COMPLETED_CLEANLY', // eslint-disable-line deprecation/deprecation

  /** @deprecated Use `undefined` instead. */
  QUERY_REJECT_CONDITION_UNSPECIFIED: undefined, // eslint-disable-line deprecation/deprecation
} as const;
export type QueryRejectCondition = (typeof QueryRejectCondition)[keyof typeof QueryRejectCondition];

export const [encodeQueryRejectCondition, decodeQueryRejectCondition] = makeProtoEnumConverters<
  proto.temporal.api.enums.v1.QueryRejectCondition,
  typeof proto.temporal.api.enums.v1.QueryRejectCondition,
  keyof typeof proto.temporal.api.enums.v1.QueryRejectCondition,
  typeof QueryRejectCondition,
  'QUERY_REJECT_CONDITION_'
>(
  {
    [QueryRejectCondition.NONE]: 1,
    [QueryRejectCondition.NOT_OPEN]: 2,
    [QueryRejectCondition.NOT_COMPLETED_CLEANLY]: 3,
    UNSPECIFIED: 0,
  } as const,
  'QUERY_REJECT_CONDITION_'
);
