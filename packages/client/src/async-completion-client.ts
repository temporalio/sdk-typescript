import { Status } from '@grpc/grpc-js/build/src/constants';
import { DataConverter, ensureTemporalFailure, LoadedDataConverter } from '@temporalio/common';
import {
  encodeErrorToFailure,
  encodeToPayloads,
  filterNullAndUndefined,
  loadDataConverter,
} from '@temporalio/internal-non-workflow-common';
import { Replace } from '@temporalio/internal-workflow-common';
import os from 'os';
import { Connection } from './connection';
import { isServerErrorResponse } from './errors';
import { ConnectionLike, WorkflowService } from './types';

/**
 * Thrown by {@link AsyncCompletionClient} when trying to complete or heartbeat an Activity that does not exist in the
 * system.
 */
export class ActivityNotFoundError extends Error {
  public readonly name = 'ActivityNotFoundError';
}

/**
 * Thrown by {@link AsyncCompletionClient} when trying to complete or heartbeat
 * an Activity for any reason apart from {@link ActivityNotFoundError}.
 */
export class ActivityCompletionError extends Error {
  public readonly name = 'ActivityCompletionError';
}

/**
 * Thrown by {@link AsyncCompletionClient.heartbeat} when the Workflow has
 * requested to cancel the reporting Activity.
 */
export class ActivityCancelledError extends Error {
  public readonly name = 'ActivityCancelledError';
}

/**
 * Options used to configure {@link AsyncCompletionClient}
 */
export interface AsyncCompletionClientOptions {
  /**
   * {@link DataConverter} to use for serializing and deserializing payloads
   */
  dataConverter?: DataConverter;

  /**
   * Identity to report to the server
   *
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;

  connection?: ConnectionLike;

  /**
   * Server namespace
   *
   * @default default
   */
  namespace?: string;
}

export type AsyncCompletionClientOptionsWithDefaults = Replace<
  Required<AsyncCompletionClientOptions>,
  {
    connection?: ConnectionLike;
  }
>;

export function defaultAsyncCompletionClientOptions(): AsyncCompletionClientOptionsWithDefaults {
  return {
    dataConverter: {},
    identity: `${process.pid}@${os.hostname()}`,
    namespace: 'default',
  };
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
 */
export class AsyncCompletionClient {
  public readonly options: AsyncCompletionClientOptionsWithDefaults;
  protected readonly dataConverter: LoadedDataConverter;
  public readonly connection: ConnectionLike;

  constructor(options?: AsyncCompletionClientOptions) {
    this.connection = options?.connection ?? Connection.lazy();
    this.dataConverter = loadDataConverter(options?.dataConverter);
    this.options = { ...defaultAsyncCompletionClientOptions(), ...filterNullAndUndefined(options ?? {}) };
  }

  get workflowService(): WorkflowService {
    return this.connection.workflowService;
  }

  /**
   * Transforms grpc errors into well defined TS errors.
   */
  protected handleError(err: unknown): never {
    if (isServerErrorResponse(err)) {
      if (err.code === Status.NOT_FOUND) {
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
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        await this.workflowService.respondActivityTaskCompleted({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          result: { payloads: await encodeToPayloads(this.dataConverter, result) },
        });
      } else {
        await this.workflowService.respondActivityTaskCompletedById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          result: { payloads: await encodeToPayloads(this.dataConverter, result) },
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
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        await this.workflowService.respondActivityTaskFailed({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          failure: await encodeErrorToFailure(this.dataConverter, ensureTemporalFailure(err)),
        });
      } else {
        await this.workflowService.respondActivityTaskFailedById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          failure: await encodeErrorToFailure(this.dataConverter, err),
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
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        await this.workflowService.respondActivityTaskCanceled({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          details: { payloads: await encodeToPayloads(this.dataConverter, details) },
        });
      } else {
        await this.workflowService.respondActivityTaskCanceledById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          details: { payloads: await encodeToPayloads(this.dataConverter, details) },
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
    try {
      if (taskTokenOrFullActivityId instanceof Uint8Array) {
        const { cancelRequested } = await this.workflowService.recordActivityTaskHeartbeat({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          details: { payloads: await encodeToPayloads(this.dataConverter, details) },
        });
        if (cancelRequested) {
          throw new ActivityCancelledError('cancelled');
        }
      } else {
        const { cancelRequested } = await this.workflowService.recordActivityTaskHeartbeatById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          details: { payloads: await encodeToPayloads(this.dataConverter, details) },
        });
        if (cancelRequested) {
          throw new ActivityCancelledError('cancelled');
        }
      }
    } catch (err) {
      if (err instanceof ActivityCancelledError) {
        throw err;
      }
      this.handleError(err);
    }
  }
}
