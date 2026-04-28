import type { Duration, SearchAttributePair, SearchAttributeType, TypedSearchAttributes } from '@temporalio/common';
import type { TypedSearchAttributeValue } from '@temporalio/common/lib/search-attributes';
import { makeProtoEnumConverters } from '@temporalio/common/lib/internal-workflow';
import type { temporal } from '@temporalio/proto';
import type { Replace } from '@temporalio/common/lib/type-helpers';

/**
 * Defines whether to allow re-using an operation ID from a previously *completed* Nexus operation.
 *
 * See {@link NexusOperationIdConflictPolicy} for handling ID duplication with a *running* operation.
 */
export const NexusOperationIdReusePolicy = {
  ALLOW_DUPLICATE: 'ALLOW_DUPLICATE',
  ALLOW_DUPLICATE_FAILED_ONLY: 'ALLOW_DUPLICATE_FAILED_ONLY',
  REJECT_DUPLICATE: 'REJECT_DUPLICATE',
} as const;
export type NexusOperationIdReusePolicy =
  (typeof NexusOperationIdReusePolicy)[keyof typeof NexusOperationIdReusePolicy];

export const [encodeNexusOperationIdReusePolicy, decodeNexusOperationIdReusePolicy] = makeProtoEnumConverters<
  temporal.api.enums.v1.NexusOperationIdReusePolicy,
  typeof temporal.api.enums.v1.NexusOperationIdReusePolicy,
  keyof typeof temporal.api.enums.v1.NexusOperationIdReusePolicy,
  typeof NexusOperationIdReusePolicy,
  'NEXUS_OPERATION_ID_REUSE_POLICY_'
>(
  {
    [NexusOperationIdReusePolicy.ALLOW_DUPLICATE]: 1,
    [NexusOperationIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY]: 2,
    [NexusOperationIdReusePolicy.REJECT_DUPLICATE]: 3,
    UNSPECIFIED: 0,
  } as const,
  'NEXUS_OPERATION_ID_REUSE_POLICY_'
);

/**
 * Defines how to resolve an operation ID conflict with a *running* Nexus operation.
 *
 * See {@link NexusOperationIdReusePolicy} for handling operation ID duplication with a *closed* operation.
 */
export const NexusOperationIdConflictPolicy = {
  FAIL: 'FAIL',
  USE_EXISTING: 'USE_EXISTING',
} as const;
export type NexusOperationIdConflictPolicy =
  (typeof NexusOperationIdConflictPolicy)[keyof typeof NexusOperationIdConflictPolicy];

export const [encodeNexusOperationIdConflictPolicy, decodeNexusOperationIdConflictPolicy] = makeProtoEnumConverters<
  temporal.api.enums.v1.NexusOperationIdConflictPolicy,
  typeof temporal.api.enums.v1.NexusOperationIdConflictPolicy,
  keyof typeof temporal.api.enums.v1.NexusOperationIdConflictPolicy,
  typeof NexusOperationIdConflictPolicy,
  'NEXUS_OPERATION_ID_CONFLICT_POLICY_'
>(
  {
    [NexusOperationIdConflictPolicy.FAIL]: 1,
    [NexusOperationIdConflictPolicy.USE_EXISTING]: 2,
    UNSPECIFIED: 0,
  } as const,
  'NEXUS_OPERATION_ID_CONFLICT_POLICY_'
);

/**
 * A general status for a Nexus operation, indicating whether it is currently running or in a terminal state.
 */
export const NexusOperationExecutionStatus = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
  TERMINATED: 'TERMINATED',
  TIMED_OUT: 'TIMED_OUT',
} as const;
export type NexusOperationExecutionStatus =
  (typeof NexusOperationExecutionStatus)[keyof typeof NexusOperationExecutionStatus];

export const [encodeNexusOperationExecutionStatus, decodeNexusOperationExecutionStatus] = makeProtoEnumConverters<
  temporal.api.enums.v1.NexusOperationExecutionStatus,
  typeof temporal.api.enums.v1.NexusOperationExecutionStatus,
  keyof typeof temporal.api.enums.v1.NexusOperationExecutionStatus,
  typeof NexusOperationExecutionStatus,
  'NEXUS_OPERATION_EXECUTION_STATUS_'
>(
  {
    [NexusOperationExecutionStatus.RUNNING]: 1,
    [NexusOperationExecutionStatus.COMPLETED]: 2,
    [NexusOperationExecutionStatus.FAILED]: 3,
    [NexusOperationExecutionStatus.CANCELED]: 4,
    [NexusOperationExecutionStatus.TERMINATED]: 5,
    [NexusOperationExecutionStatus.TIMED_OUT]: 6,
    UNSPECIFIED: 0,
  } as const,
  'NEXUS_OPERATION_EXECUTION_STATUS_'
);

/**
 * A more detailed breakdown of {@link NexusOperationExecutionStatus.RUNNING}.
 */
export const PendingNexusOperationState = {
  SCHEDULED: 'SCHEDULED',
  BACKING_OFF: 'BACKING_OFF',
  STARTED: 'STARTED',
  BLOCKED: 'BLOCKED',
} as const;
export type PendingNexusOperationState = (typeof PendingNexusOperationState)[keyof typeof PendingNexusOperationState];

export const [encodePendingNexusOperationState, decodePendingNexusOperationState] = makeProtoEnumConverters<
  temporal.api.enums.v1.PendingNexusOperationState,
  typeof temporal.api.enums.v1.PendingNexusOperationState,
  keyof typeof temporal.api.enums.v1.PendingNexusOperationState,
  typeof PendingNexusOperationState,
  'PENDING_NEXUS_OPERATION_STATE_'
>(
  {
    [PendingNexusOperationState.SCHEDULED]: 1,
    [PendingNexusOperationState.BACKING_OFF]: 2,
    [PendingNexusOperationState.STARTED]: 3,
    [PendingNexusOperationState.BLOCKED]: 4,
    UNSPECIFIED: 0,
  } as const,
  'PENDING_NEXUS_OPERATION_STATE_'
);

/**
 * State of a Nexus operation cancellation.
 */
export const NexusOperationCancellationState = {
  SCHEDULED: 'SCHEDULED',
  BACKING_OFF: 'BACKING_OFF',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  BLOCKED: 'BLOCKED',
} as const;
export type NexusOperationCancellationState =
  (typeof NexusOperationCancellationState)[keyof typeof NexusOperationCancellationState];

export const [encodeNexusOperationCancellationState, decodeNexusOperationCancellationState] = makeProtoEnumConverters<
  temporal.api.enums.v1.NexusOperationCancellationState,
  typeof temporal.api.enums.v1.NexusOperationCancellationState,
  keyof typeof temporal.api.enums.v1.NexusOperationCancellationState,
  typeof NexusOperationCancellationState,
  'NEXUS_OPERATION_CANCELLATION_STATE_'
>(
  {
    [NexusOperationCancellationState.SCHEDULED]: 1,
    [NexusOperationCancellationState.BACKING_OFF]: 2,
    [NexusOperationCancellationState.SUCCEEDED]: 3,
    [NexusOperationCancellationState.FAILED]: 4,
    [NexusOperationCancellationState.TIMED_OUT]: 5,
    [NexusOperationCancellationState.BLOCKED]: 6,
    UNSPECIFIED: 0,
  } as const,
  'NEXUS_OPERATION_CANCELLATION_STATE_'
);

export type RawNexusOperationExecutionInfo = temporal.api.nexus.v1.INexusOperationExecutionInfo;
export type RawNexusOperationExecutionListInfo = temporal.api.nexus.v1.INexusOperationExecutionListInfo;
export type RawNexusOperationExecutionCancellationInfo = temporal.api.nexus.v1.INexusOperationExecutionCancellationInfo;

/**
 * Cancellation state for a standalone Nexus operation.
 */
export interface NexusOperationExecutionCancellationInfo {
  /**
   * The time when cancellation was requested.
   */
  readonly requestedTime: Date | undefined;

  /**
   * The current state of the cancellation request.
   */
  readonly state: NexusOperationCancellationState | undefined;

  /**
   * The number of attempts made to deliver the cancel operation request.
   */
  readonly attempt: number;

  /**
   * The time when the last attempt completed.
   */
  readonly lastAttemptCompleteTime: Date | undefined;

  /**
   * The time when the next attempt is scheduled.
   */
  readonly nextAttemptScheduleTime: Date | undefined;

  /**
   * The last attempt's failure, if any.
   */
  readonly lastAttemptFailure: Error | undefined;

  /**
   * Blocked reason provides additional information if the cancellation state is {@link NexusOperationCancellationState.BLOCKED}.
   */
  readonly blockedReason: string | undefined;

  /**
   * The reason specified in the cancellation request.
   */
  readonly reason: string;

  /**
   * Underlying protobuf cancellation info.
   */
  readonly raw: RawNexusOperationExecutionCancellationInfo;
}

/**
 * Info for a standalone Nexus operation execution, from list response.
 */
export interface NexusOperationExecution {
  /**
   * Unique identifier of this operation.
   */
  readonly operationId: string;

  /**
   * The run ID of the standalone Nexus operation.
   */
  readonly runId: string;

  /**
   * Endpoint name.
   */
  readonly endpoint: string;

  /**
   * Service name.
   */
  readonly service: string;

  /**
   * Operation name.
   */
  readonly operation: string;

  /**
   * The time the operation was originally scheduled.
   */
  readonly scheduleTime: Date | undefined;

  /**
   * Time the operation reached a terminal status, if closed.
   */
  readonly closeTime: Date | undefined;

  /**
   * Current status of the operation.
   */
  readonly status: NexusOperationExecutionStatus | undefined;

  /**
   * Current set of search attributes if any.
   */
  readonly searchAttributes: TypedSearchAttributes;

  /**
   * Number of state transitions.
   */
  readonly stateTransitionCount: number;

  /**
   * Duration from scheduled to close time, only populated if closed.
   */
  readonly executionDuration: number | undefined;

  /**
   * Underlying protobuf info.
   */
  readonly raw: RawNexusOperationExecutionListInfo;
}

/**
 * Detailed information about a standalone Nexus operation execution.
 */
export type NexusOperationExecutionDescription = Replace<
  NexusOperationExecution,
  {
    raw: temporal.api.nexus.v1.INexusOperationExecutionInfo;
  }
> & {
  /**
   * More detailed breakdown if status is {@link NexusOperationExecutionStatus.RUNNING}.
   */
  readonly state: PendingNexusOperationState | undefined;

  /**
   * Schedule-to-close timeout for this operation in milliseconds.
   */
  readonly scheduleToCloseTimeout: number | undefined;

  /**
   * Schedule-to-start timeout for this operation in milliseconds.
   */
  readonly scheduleToStartTimeout: number | undefined;

  /**
   * Start-to-close timeout for this operation in milliseconds.
   */
  readonly startToCloseTimeout: number | undefined;

  /**
   * Current attempt number.
   */
  readonly attempt: number;

  /**
   * Scheduled time plus schedule_to_close_timeout.
   */
  readonly expirationTime: Date | undefined;

  /**
   * Time when the last attempt completed.
   */
  readonly lastAttemptCompleteTime: Date | undefined;

  /**
   * Time when the next attempt will be scheduled.
   */
  readonly nextAttemptScheduleTime: Date | undefined;

  /**
   * Failure from the last failed attempt, if any.
   */
  readonly lastAttemptFailure: Error | undefined;

  /**
   * Reason the operation is blocked, if any.
   */
  readonly blockedReason: string | undefined;

  /**
   * Server-generated request ID used as an idempotency token.
   */
  readonly requestId: string;

  /**
   * operationToken is only set for asynchronous operations after a successful start_operation call.
   */
  readonly operationToken: string | undefined;

  /**
   * Identity of the client that started this operation.
   */
  readonly identity: string;

  /**
   * Cancellation info if cancellation was requested.
   */
  readonly cancellationInfo: NexusOperationExecutionCancellationInfo | undefined;

  /**
   * Token for follow-on long-poll requests. None if the operation is complete.
   */
  readonly longPollToken: Uint8Array | undefined;

  staticSummary: () => Promise<string | undefined>;
  staticDetails: () => Promise<string | undefined>;
};

/**
 * Count of standalone Nexus operation executions, optionally grouped by a search attribute.
 */
export interface NexusOperationExecutionCount {
  readonly count: number;
  readonly groups: readonly NexusOperationExecutionCountGroup[];
}

/**
 * A group within a count aggregation.
 */
export interface NexusOperationExecutionCountGroup {
  readonly count: number;
  readonly groupValues: readonly TypedSearchAttributeValue<SearchAttributeType>[];
}

/**
 * Options for starting a standalone Nexus operation via
 * {@link NexusServiceClient.startOperation} or {@link NexusServiceClient.executeOperation}.
 */
export interface StartNexusOperationOptions {
  /**
   * Caller-side identifier for this operation. Must be unique among operations in the
   * same namespace, subject to {@link idReusePolicy} and {@link idConflictPolicy}.
   */
  id: string;

  /**
   * Schedule-to-close timeout for this operation.
   */
  scheduleToCloseTimeout?: Duration;

  /**
   * Single-line Temporal-markdown summary used by user interfaces to display operation metadata.
   */
  summary?: string;

  /**
   * How to handle an operation ID that was used by a previously closed operation.
   * @default {@link NexusOperationIdReusePolicy.ALLOW_DUPLICATE}
   */
  idReusePolicy?: NexusOperationIdReusePolicy;

  /**
   * How to handle an operation ID that is in use by a currently running operation.
   * @default {@link NexusOperationIdConflictPolicy.FAIL}
   */
  idConflictPolicy?: NexusOperationIdConflictPolicy;

  /**
   * Search attributes for indexing.
   */
  searchAttributes?: SearchAttributePair[] | TypedSearchAttributes;

  /**
   * Headers to attach to the Nexus request. Transmitted to the handler as-is.
   * Useful for propagating tracing information.
   */
  headers?: Record<string, string>;
}

/**
 * Options for {@link NexusClient.list}.
 */
export interface ListNexusOperationsOptions {
  /**
   * Visibility list filter query. See https://docs.temporal.io/list-filter for syntax.
   */
  query?: string;

  /**
   * Maximum number of operations to return per page.
   */
  pageSize?: number;
}

/**
 * Options for {@link NexusClient.getHandle}.
 */
export interface GetNexusOperationHandleOptions {
  /**
   * If provided, targets this specific run of the operation. If absent, targets the latest run.
   */
  runId?: string;
}

/**
 * Options for {@link NexusOperationHandle.describe}
 */
export interface DescribeNexusOperationOptions {
  /**
   *  Token from a previous describe response.
   *  If provided, the request will long-poll until the Nexus Operation state changes.
   */
  longPollToken?: Uint8Array;
}
