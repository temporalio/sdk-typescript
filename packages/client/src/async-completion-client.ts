import { status as grpcStatus } from '@grpc/grpc-js';
import type { ActivitySerializationContext, StorageDriverActivityInfo } from '@temporalio/common';
import { ensureTemporalFailure } from '@temporalio/common';
import {
  encodeErrorToFailure,
  encodeToPayloadsWithContext,
  extstoreStoreOptions,
  visit,
  walkRecordActivityTaskHeartbeatByIdRequest,
  walkRecordActivityTaskHeartbeatRequest,
  walkRespondActivityTaskCanceledByIdRequest,
  walkRespondActivityTaskCanceledRequest,
  walkRespondActivityTaskCompletedByIdRequest,
  walkRespondActivityTaskCompletedRequest,
  walkRespondActivityTaskFailedByIdRequest,
  walkRespondActivityTaskFailedRequest,
} from '@temporalio/common/lib/internal-non-workflow';
import { filterNullAndUndefined } from '@temporalio/common/lib/internal-workflow';
import type { temporal } from '@temporalio/proto';
import type { BaseClientOptions, LoadedWithDefaults, WithDefaults } from './base-client';
import { BaseClient, defaultBaseClientOptions } from './base-client';
import {
  isGrpcServiceError,
  ActivityNotFoundError,
  ActivityCompletionError,
  ActivityCancelledError,
  ActivityResetError,
  ActivityPausedError,
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
 * Options for async Activity completion, failure, cancellation, and heartbeat operations.
 */
export interface AsyncCompletionOperationOptions {
  /**
   * Serialization context to use when converting payloads and failures for task-token operations.
   *
   * By-ID operations infer their Activity serialization context from the supplied IDs.
   *
   * @experimental Serialization context is an experimental feature and may change.
   */
  serializationContext?: ActivitySerializationContext;
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

function activityContextFromFullActivityId(
  namespace: string,
  fullActivityId: FullActivityId
): ActivitySerializationContext {
  return {
    type: 'activity',
    namespace,
    workflowId: fullActivityId.workflowId,
    activityId: fullActivityId.activityId,
    isLocal: false,
  };
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

  protected serializationContextFor(
    taskTokenOrFullActivityId: Uint8Array | FullActivityId,
    options?: AsyncCompletionOperationOptions
  ): ActivitySerializationContext | undefined {
    return taskTokenOrFullActivityId instanceof Uint8Array
      ? options?.serializationContext
      : activityContextFromFullActivityId(this.options.namespace, taskTokenOrFullActivityId);
  }

  /**
   * Storage target for offloaded payloads. By-ID operations carry the Activity ID; by-token operations
   * only know the namespace (the token is opaque), so the target is namespace-scoped and the driver falls
   * back to content-addressed naming.
   */
  protected storageTargetFor(taskTokenOrFullActivityId: Uint8Array | FullActivityId): StorageDriverActivityInfo {
    return taskTokenOrFullActivityId instanceof Uint8Array
      ? { kind: 'activity', namespace: this.options.namespace }
      : { kind: 'activity', namespace: this.options.namespace, id: taskTokenOrFullActivityId.activityId };
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
  async complete(taskToken: Uint8Array, result: unknown, options?: AsyncCompletionOperationOptions): Promise<void>;
  /**
   * Complete an Activity by full ID
   */
  async complete(fullActivityId: FullActivityId, result: unknown): Promise<void>;

  async complete(
    taskTokenOrFullActivityId: Uint8Array | FullActivityId,
    result: unknown,
    options?: AsyncCompletionOperationOptions
  ): Promise<void> {
    const payloads = await encodeToPayloadsWithContext(
      this.dataConverter,
      this.serializationContextFor(taskTokenOrFullActivityId, options),
      [result]
    );
    const externalStorage = this.dataConverter.externalStorage;
    const target = this.storageTargetFor(taskTokenOrFullActivityId);
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        const req: temporal.api.workflowservice.v1.IRespondActivityTaskCompletedRequest = {
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          result: { payloads },
        };
        if (externalStorage) {
          await visit(
            req,
            walkRespondActivityTaskCompletedRequest,
            extstoreStoreOptions(externalStorage, { initialTarget: target })
          );
        }
        await this.workflowService.respondActivityTaskCompleted(req);
      } else {
        const req: temporal.api.workflowservice.v1.IRespondActivityTaskCompletedByIdRequest = {
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          result: { payloads },
        };
        if (externalStorage) {
          await visit(
            req,
            walkRespondActivityTaskCompletedByIdRequest,
            extstoreStoreOptions(externalStorage, { initialTarget: target })
          );
        }
        await this.workflowService.respondActivityTaskCompletedById(req);
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  /**
   * Fail an Activity by task token
   */
  async fail(taskToken: Uint8Array, err: unknown, options?: AsyncCompletionOperationOptions): Promise<void>;
  /**
   * Fail an Activity by full ID
   */
  async fail(fullActivityId: FullActivityId, err: unknown): Promise<void>;

  async fail(
    taskTokenOrFullActivityId: Uint8Array | FullActivityId,
    err: unknown,
    options?: AsyncCompletionOperationOptions
  ): Promise<void> {
    const failure = await encodeErrorToFailure(
      this.dataConverter,
      ensureTemporalFailure(err),
      this.serializationContextFor(taskTokenOrFullActivityId, options)
    );
    const externalStorage = this.dataConverter.externalStorage;
    const target = this.storageTargetFor(taskTokenOrFullActivityId);
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        const req: temporal.api.workflowservice.v1.IRespondActivityTaskFailedRequest = {
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          failure,
        };
        if (externalStorage) {
          await visit(
            req,
            walkRespondActivityTaskFailedRequest,
            extstoreStoreOptions(externalStorage, { initialTarget: target })
          );
        }
        await this.workflowService.respondActivityTaskFailed(req);
      } else {
        const req: temporal.api.workflowservice.v1.IRespondActivityTaskFailedByIdRequest = {
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          failure,
        };
        if (externalStorage) {
          await visit(
            req,
            walkRespondActivityTaskFailedByIdRequest,
            extstoreStoreOptions(externalStorage, { initialTarget: target })
          );
        }
        await this.workflowService.respondActivityTaskFailedById(req);
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  /**
   * Report Activity cancellation by task token
   */
  reportCancellation(
    taskToken: Uint8Array,
    details?: unknown,
    options?: AsyncCompletionOperationOptions
  ): Promise<void>;
  /**
   * Report Activity cancellation by full ID
   */
  reportCancellation(fullActivityId: FullActivityId, details?: unknown): Promise<void>;

  async reportCancellation(
    taskTokenOrFullActivityId: Uint8Array | FullActivityId,
    details?: unknown,
    options?: AsyncCompletionOperationOptions
  ): Promise<void> {
    const payloads = await encodeToPayloadsWithContext(
      this.dataConverter,
      this.serializationContextFor(taskTokenOrFullActivityId, options),
      [details]
    );
    const externalStorage = this.dataConverter.externalStorage;
    const target = this.storageTargetFor(taskTokenOrFullActivityId);
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        const req: temporal.api.workflowservice.v1.IRespondActivityTaskCanceledRequest = {
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          details: { payloads },
        };
        if (externalStorage) {
          await visit(
            req,
            walkRespondActivityTaskCanceledRequest,
            extstoreStoreOptions(externalStorage, { initialTarget: target })
          );
        }
        await this.workflowService.respondActivityTaskCanceled(req);
      } else {
        const req: temporal.api.workflowservice.v1.IRespondActivityTaskCanceledByIdRequest = {
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          details: { payloads },
        };
        if (externalStorage) {
          await visit(
            req,
            walkRespondActivityTaskCanceledByIdRequest,
            extstoreStoreOptions(externalStorage, { initialTarget: target })
          );
        }
        await this.workflowService.respondActivityTaskCanceledById(req);
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  /**
   * Send Activity heartbeat by task token
   */
  heartbeat(taskToken: Uint8Array, details?: unknown, options?: AsyncCompletionOperationOptions): Promise<void>;
  /**
   * Send Activity heartbeat by full ID
   */
  heartbeat(fullActivityId: FullActivityId, details?: unknown): Promise<void>;

  async heartbeat(
    taskTokenOrFullActivityId: Uint8Array | FullActivityId,
    details?: unknown,
    options?: AsyncCompletionOperationOptions
  ): Promise<void> {
    const payloads = await encodeToPayloadsWithContext(
      this.dataConverter,
      this.serializationContextFor(taskTokenOrFullActivityId, options),
      [details]
    );
    let cancelRequested = false;
    let paused = false;
    let reset = false;
    const externalStorage = this.dataConverter.externalStorage;
    const target = this.storageTargetFor(taskTokenOrFullActivityId);
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        const req: temporal.api.workflowservice.v1.IRecordActivityTaskHeartbeatRequest = {
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          details: { payloads },
        };
        if (externalStorage) {
          await visit(
            req,
            walkRecordActivityTaskHeartbeatRequest,
            extstoreStoreOptions(externalStorage, { initialTarget: target })
          );
        }
        const response = await this.workflowService.recordActivityTaskHeartbeat(req);
        cancelRequested = !!response.cancelRequested;
        paused = !!response.activityPaused;
        reset = !!response.activityReset;
      } else {
        const req: temporal.api.workflowservice.v1.IRecordActivityTaskHeartbeatByIdRequest = {
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          details: { payloads },
        };
        if (externalStorage) {
          await visit(
            req,
            walkRecordActivityTaskHeartbeatByIdRequest,
            extstoreStoreOptions(externalStorage, { initialTarget: target })
          );
        }
        const response = await this.workflowService.recordActivityTaskHeartbeatById(req);
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
