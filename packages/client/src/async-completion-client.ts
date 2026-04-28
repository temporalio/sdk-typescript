import { status as grpcStatus } from '@grpc/grpc-js';
import { ensureTemporalFailure } from '@temporalio/common';
import { encodeErrorToFailure, encodeToPayloads } from '@temporalio/common/lib/internal-non-workflow';
import { filterNullAndUndefined } from '@temporalio/common/lib/internal-workflow';
import type { BaseClientOptions, LoadedWithDefaults, WithDefaults } from './base-client';
import { BaseClient, defaultBaseClientOptions } from './base-client';
import {
  isGrpcServiceError, ActivityNotFoundError, ActivityCompletionError, ActivityCancelledError,
  ActivityResetError, ActivityPausedError,
} from './errors';
import type { WorkflowService } from './types';
import { rethrowKnownErrorTypes } from './helpers';

/**
 * Options used to configure {@link AsyncCompletionClient}
 */
export type AsyncCompletionClientOptions = BaseClientOptions;

export type LoadedAsyncCompletionClientOptions = LoadedWithDefaults<AsyncCompletionClientOptions>;

function defaultAsyncCompletionClientOptions(): WithDefaults<AsyncCompletionClientOptions> {
  return defaultBaseClientOptions();
}

/**
 * A mostly unique Activity identifier. If {@link workflowId} is set, it refers to a Workflow Activity.
 * If {@link workflowId} is unset, it refers to a Standalone Activity. In both cases, it can optionally contain
 * {@link runId}.
 *
 * Activity IDs may be reused in a single Workflow run as long as a previous Activity with the same ID has completed
 * already. Standalone Activity IDs may be reused if `idReusePolicy` is set in Activity options when starting a new
 * Activity, but a combination of Activity ID and Activity run ID is unique.
 */
export interface FullActivityId {
  /**
   * ID of the Workflow that started the Activity. Unset for Standalone Activities.
   */
  workflowId?: string;
  /**
   * If {@link workflowId} is set, this optionally specifies the Workflow run ID in order to differentiate between
   * Workflow runs with the same Workflow ID. If {@link workflowId} is unset, this optionally specifies the
   * Activity run ID in order to differentiate between Standalone Activity runs with the same Activity ID.
   *
   * If {@link runId} is unset, then the {@link FullActivityId} object refers to the latest run of the Workflow or
   * the Standalone Activity with the specified ID.
   */
  runId?: string;
  /**
   * ID of the Activity.
   */
  activityId: string;
}

/**
 * A client for asynchronous completion and heartbeating of Activities.
 *
 * Typically this client should not be instantiated directly, instead create the high level {@link Client} and use
 * {@link Client.activity} to complete async activities.
 */
export class AsyncCompletionClient extends BaseClient {
  public readonly options: LoadedAsyncCompletionClientOptions;

  constructor(options?: AsyncCompletionClientOptions) {
    super(options);
    this.options = {
      ...defaultAsyncCompletionClientOptions(),
      ...filterNullAndUndefined(options ?? {}),
      loadedDataConverter: this.dataConverter,
    };
  }

  /**
   * Raw gRPC access to the Temporal service.
   *
   * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests made via this service
   * object.
   */
  get workflowService(): WorkflowService {
    return this.connection.workflowService;
  }

  /**
   * Transforms grpc errors into well defined TS errors.
   */
  protected handleError(err: unknown): never {
    if (isGrpcServiceError(err)) {
      rethrowKnownErrorTypes(err);

      if (err.code === grpcStatus.NOT_FOUND) {
        throw new ActivityNotFoundError('Not found');
      }

      throw new ActivityCompletionError(err.details || err.message);
    }
    throw new ActivityCompletionError('Unexpected failure');
  }

  /**
   * Complete an Activity by task token
   */
  async complete(taskToken: Uint8Array, result: unknown): Promise<void>;
  /**
   * Complete an Activity by full ID
   */
  async complete(fullActivityId: FullActivityId, result: unknown): Promise<void>;

  async complete(taskTokenOrFullActivityId: Uint8Array | FullActivityId, result: unknown): Promise<void> {
    const payloads = await encodeToPayloads(this.dataConverter, result);
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        await this.workflowService.respondActivityTaskCompleted({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          result: { payloads },
        });
      } else {
        await this.workflowService.respondActivityTaskCompletedById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          result: { payloads },
        });
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  /**
   * Fail an Activity by task token
   */
  async fail(taskToken: Uint8Array, err: unknown): Promise<void>;
  /**
   * Fail an Activity by full ID
   */
  async fail(fullActivityId: FullActivityId, err: unknown): Promise<void>;

  async fail(taskTokenOrFullActivityId: Uint8Array | FullActivityId, err: unknown): Promise<void> {
    const failure = await encodeErrorToFailure(this.dataConverter, ensureTemporalFailure(err));
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        await this.workflowService.respondActivityTaskFailed({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          failure,
        });
      } else {
        await this.workflowService.respondActivityTaskFailedById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          failure,
        });
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  /**
   * Report Activity cancellation by task token
   */
  reportCancellation(taskToken: Uint8Array, details?: unknown): Promise<void>;
  /**
   * Report Activity cancellation by full ID
   */
  reportCancellation(fullActivityId: FullActivityId, details?: unknown): Promise<void>;

  async reportCancellation(taskTokenOrFullActivityId: Uint8Array | FullActivityId, details?: unknown): Promise<void> {
    const payloads = await encodeToPayloads(this.dataConverter, details);
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        await this.workflowService.respondActivityTaskCanceled({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          details: { payloads },
        });
      } else {
        await this.workflowService.respondActivityTaskCanceledById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          details: { payloads },
        });
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  /**
   * Send Activity heartbeat by task token
   */
  heartbeat(taskToken: Uint8Array, details?: unknown): Promise<void>;
  /**
   * Send Activity heartbeat by full ID
   */
  heartbeat(fullActivityId: FullActivityId, details?: unknown): Promise<void>;

  async heartbeat(taskTokenOrFullActivityId: Uint8Array | FullActivityId, details?: unknown): Promise<void> {
    const payloads = await encodeToPayloads(this.dataConverter, details);
    let cancelRequested = false;
    let paused = false;
    let reset = false;
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        const response = await this.workflowService.recordActivityTaskHeartbeat({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          details: { payloads },
        });
        cancelRequested = !!response.cancelRequested;
        paused = !!response.activityPaused;
        reset = !!response.activityReset;
      } else {
        const response = await this.workflowService.recordActivityTaskHeartbeatById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          details: { payloads },
        });
        cancelRequested = !!response.cancelRequested;
        paused = !!response.activityPaused;
        reset = !!response.activityReset;
      }
    } catch (err) {
      this.handleError(err);
    }
    // Note that it is possible for a heartbeat response to have multiple fields
    // set as true (i.e. cancelled and pause).
    if (cancelRequested) {
      throw new ActivityCancelledError('cancelled');
    } else if (reset) {
      throw new ActivityResetError('reset');
    } else if (paused) {
      throw new ActivityPausedError('paused');
    }
  }
}
