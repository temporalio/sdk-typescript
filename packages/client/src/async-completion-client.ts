import os from 'os';
import { Status } from '@grpc/grpc-js/build/src/constants';
import {
  DataConverter,
  defaultDataConverter,
  ensureTemporalFailure,
  errorToFailure,
  filterNullAndUndefined,
} from '@temporalio/common';
import { Connection, WorkflowService } from './connection';
import { isServerErrorResponse } from './errors';

/**
 * Thrown by {@link AsyncCompletionClient} when trying to complete or heartbeat
 * an Activity which does not exist in the system.
 */
export class ActivityNotFoundError extends Error {
  public readonly name = 'ActivityNotFoundError';
}

/**
 * Thrown by {@link AsyncCompletionClient} when trying to complete or heartbeat
 * an Activity for any reason apart from "not found".
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

  /**
   * Server namespace
   *
   * @default default
   */
  namespace?: string;
}

export type AsyncCompletionClientOptionsWithDefaults = Required<AsyncCompletionClientOptions>;

export function defaultAsyncCompletionClientOptions(): AsyncCompletionClientOptionsWithDefaults {
  return {
    dataConverter: defaultDataConverter,
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

  constructor(
    public readonly service: WorkflowService = new Connection().service,
    options?: AsyncCompletionClientOptions
  ) {
    this.options = { ...defaultAsyncCompletionClientOptions(), ...filterNullAndUndefined(options ?? {}) };
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
    throw new ActivityCompletionError('Unexpeced failure');
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
        await this.service.respondActivityTaskCompleted({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          result: { payloads: await this.options.dataConverter.toPayloads(result) },
        });
      } else {
        await this.service.respondActivityTaskCompletedById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          result: { payloads: await this.options.dataConverter.toPayloads(result) },
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
        await this.service.respondActivityTaskFailed({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          failure: await errorToFailure(ensureTemporalFailure(err), this.options.dataConverter),
        });
      } else {
        await this.service.respondActivityTaskFailedById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          failure: await errorToFailure(err, this.options.dataConverter),
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
        await this.service.respondActivityTaskCanceled({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          details: { payloads: await this.options.dataConverter.toPayloads(details) },
        });
      } else {
        await this.service.respondActivityTaskCanceledById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          details: { payloads: await this.options.dataConverter.toPayloads(details) },
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
        const { cancelRequested } = await this.service.recordActivityTaskHeartbeat({
          identity: this.options.identity,
          namespace: this.options.namespace,
          taskToken: taskTokenOrFullActivityId,
          details: { payloads: await this.options.dataConverter.toPayloads(details) },
        });
        if (cancelRequested) {
          throw new ActivityCancelledError('cancelled');
        }
      } else {
        const { cancelRequested } = await this.service.recordActivityTaskHeartbeatById({
          identity: this.options.identity,
          namespace: this.options.namespace,
          ...taskTokenOrFullActivityId,
          details: { payloads: await this.options.dataConverter.toPayloads(details) },
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
