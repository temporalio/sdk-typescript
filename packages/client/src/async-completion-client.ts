import { status as grpcStatus } from '@grpc/grpc-js';
import { ensureTemporalFailure } from '@temporalio/common';
import {
  encodeErrorToFailure,
  encodeToPayloads,
  filterNullAndUndefined,
} from '@temporalio/common/lib/internal-non-workflow';
import { SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';
import {
  BaseClient,
  BaseClientOptions,
  defaultBaseClientOptions,
  LoadedWithDefaults,
  WithDefaults,
} from './base-client';
import { isGrpcServiceError } from './errors';
import { WorkflowService } from './types';
import { rethrowKnownErrorTypes } from './helpers';

/**
 * Thrown by {@link AsyncCompletionClient} when trying to complete or heartbeat an Activity that does not exist in the
 * system.
 */
@SymbolBasedInstanceOfError('ActivityNotFoundError')
export class ActivityNotFoundError extends Error {}

/**
 * Thrown by {@link AsyncCompletionClient} when trying to complete or heartbeat
 * an Activity for any reason apart from {@link ActivityNotFoundError}.
 */
@SymbolBasedInstanceOfError('ActivityCompletionError')
export class ActivityCompletionError extends Error {}

/**
 * Thrown by {@link AsyncCompletionClient.heartbeat} when the Workflow has
 * requested to cancel the reporting Activity.
 */
@SymbolBasedInstanceOfError('ActivityCancelledError')
export class ActivityCancelledError extends Error {}

/**
 * Options used to configure {@link AsyncCompletionClient}
 */
export type AsyncCompletionClientOptions = BaseClientOptions;

export type LoadedAsyncCompletionClientOptions = LoadedWithDefaults<AsyncCompletionClientOptions>;

function defaultAsyncCompletionClientOptions(): WithDefaults<AsyncCompletionClientOptions> {
  return defaultBaseClientOptions();
}

/**
 * A mostly unique Activity identifier including its scheduling workflow's ID
 * and an optional runId.
 *
 * Activity IDs may be reused in a single Workflow run as long as a previous
 * Activity with the same ID has completed already.
 */
export interface FullActivityId {
  workflowId: string;
  runId?: string;
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
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        const response = await this.workflowService.recordActivityTaskHeartbeat({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          details: { payloads },
        });
        cancelRequested = !!response.cancelRequested;
      } else {
        const response = await this.workflowService.recordActivityTaskHeartbeatById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          details: { payloads },
        });
        cancelRequested = !!response.cancelRequested;
      }
    } catch (err) {
      this.handleError(err);
    }
    if (cancelRequested) {
      throw new ActivityCancelledError('cancelled');
    }
  }
}
