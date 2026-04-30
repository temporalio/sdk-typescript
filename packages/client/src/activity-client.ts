import { status as grpcStatus } from '@grpc/grpc-js';
import { v4 as uuid4 } from 'uuid';
import type {
  ActivityFunction,
  LoadedDataConverter,
  Next,
  Priority,
  RetryPolicy,
  SearchAttributePair,
  TypedSearchAttributes,
} from '@temporalio/common';
import {
  compilePriority,
  compileRetryPolicy,
  convertDeploymentVersion,
  decodePriority,
  decompileRetryPolicy,
} from '@temporalio/common';
import type { Duration } from '@temporalio/common/lib/time';
import { msOptionalToTs, optionalTsToDate, optionalTsToMs } from '@temporalio/common/lib/time';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import {
  decodeTypedSearchAttributes,
  encodeUnifiedSearchAttributes,
  searchAttributePayloadConverter,
} from '@temporalio/common/lib/converter/payload-search-attributes';
import {
  decodeArrayFromPayloads,
  decodeFromPayloadsAtIndex,
  decodeOptionalFailureToOptionalError,
  encodeToPayloads,
  encodeUserMetadata,
} from '@temporalio/common/lib/internal-non-workflow';
import { temporal } from '@temporalio/proto';
import type { Replace } from '@temporalio/common/lib/type-helpers';
import type {
  ActivityCancelInput,
  ActivityClientInterceptor,
  ActivityCountInput,
  ActivityDescribeInput,
  ActivityGetResultInput,
  ActivityListInput,
  ActivityStartInput,
  ActivityTerminateInput,
} from './interceptors';
import type { AsyncCompletionClientOptions } from './async-completion-client';
import { AsyncCompletionClient } from './async-completion-client';
import type {
  ActivityExecutionDescription,
  ActivityExecutionInfo,
  ActivityIdConflictPolicy,
  ActivityIdReusePolicy,
  CountActivityExecutions,
} from './types';
import {
  decodeActivityExecutionStatus,
  decodePendingActivityState,
  encodeActivityIdConflictPolicy,
  encodeActivityIdReusePolicy,
} from './types';
import type { ErrorDetailsName } from './helpers';
import { rethrowKnownErrorTypes, trimGrpcTypeUrl, getGrpcStatusDetails } from './helpers';
import {
  isGrpcServiceError,
  ServiceError,
  ActivityNotFoundError,
  ActivityExecutionFailedError,
  ActivityExecutionAlreadyStartedError,
} from './errors';

/**
 * Options used to configure {@link ActivityClient}
 */
export interface ActivityClientOptions extends AsyncCompletionClientOptions {
  interceptors?: ActivityClientInterceptor[];
}

/**
 * Client for starting and managing Activities, and for asynchronous completion and heartbeating of Activities.
 * Includes all functionality of {@link AsyncCompletionClient}.
 *
 * Typically this client should not be instantiated directly, instead create the high level {@link Client} and use
 * {@link Client.activity} to interact with Activities.
 */
export class ActivityClient extends AsyncCompletionClient implements TypedActivityClient<any> {
  private readonly interceptedHandlers: {
    [K in keyof Required<ActivityClientInterceptor>]: Next<ActivityClientInterceptor, K>;
  };

  constructor(options?: ActivityClientOptions) {
    super(options);

    const interceptors = options?.interceptors ?? [];
    this.interceptedHandlers = {
      start: composeInterceptors(interceptors, 'start', this.startHandler.bind(this)),
      getResult: composeInterceptors(interceptors, 'getResult', this.getResultHandler.bind(this)),
      describe: composeInterceptors(interceptors, 'describe', this.describeHandler.bind(this)),
      cancel: composeInterceptors(interceptors, 'cancel', this.cancelHandler.bind(this)),
      terminate: composeInterceptors(interceptors, 'terminate', this.terminateHandler.bind(this)),
      list: composeInterceptors(interceptors, 'list', this.listHandler.bind(this)),
      count: composeInterceptors(interceptors, 'count', this.countHandler.bind(this)),
    };
  }

  /**
   * Returns this client as a {@link TypedActivityClient}. It enables strong type checking of Activity name, arguments
   * and result based on the provided Activity interface. Note that no new client object is created - this method only
   * affects type annotations.
   * @template T Activity interface to use for type checking. The returned client can only start activities present in
   * this interface.
   */
  typed<T>(): TypedActivityClient<T> {
    return this;
  }

  /**
   * Starts new Standalone Activity execution.
   *
   * @param activity Name of the activity to start.
   * @param options Options controlling the start and execution of the activity.
   * @returns Handle to the started activity. The handle's `runId` property will be set to the started run.
   */
  async start<R = any>(activity: string, options: ActivityOptions): Promise<ActivityHandle<R>> {
    return this.interceptedHandlers.start({
      activityType: activity,
      options,
      headers: {},
    });
  }

  /**
   * Executes a Standalone Activity until completion and returns the result.
   * @param activity Name of the activity to start.
   * @param options Options controlling the activity execution.
   * @returns Result of the activity.
   */
  async execute<R = any>(activity: string, options: ActivityOptions): Promise<R> {
    const handle = await this.start(activity, options);
    return handle.result();
  }

  /**
   * Creates an Activity handle from ID and optionally from run ID. If `runId` is not set, the handle will refer to the
   * newest Activity run with the given Activity ID.
   *
   * Note 1: this function always succeeds. If the provided ID is invalid, an error will only be thrown when calling
   * the handle's methods.
   *
   * Note 2: if `runID` is not set when calling `getHandle`, then `runId` property of the returned handle will always
   * remain unset, even after method calls are performed. To get the run ID of the targeted activity execution, call
   * {@link ActivityHandle.describe} and read the `activityRunId` field of the returned {@link ActivityExecutionDescription}.
   *
   * @param activityId ID of the Activity.
   * @param runId Optional run ID of the specific Activity execution.
   * @returns Handle to the specified activity execution.
   */
  getHandle<R = any>(activityId: string, runId?: string): ActivityHandle<R> {
    return this.createHandle(activityId, runId);
  }

  /**
   * Return a list of Activity executions matching the given `query`.
   *
   * Note that the list of Activity executions returned is approximate and eventually consistent.
   *
   * More info on the concept of "visibility" and the query syntax on the Temporal documentation site:
   * https://docs.temporal.io/visibility
   */
  list(query: string): AsyncIterable<ActivityExecutionInfo> {
    return this.interceptedHandlers.list({
      query,
      headers: {},
    });
  }

  /**
   * Return the number of Activity executions matching the given `query`.
   *
   * Note that the number of Activity executions returned is approximate and eventually consistent.
   *
   * More info on the concept of "visibility" and the query syntax on the Temporal documentation site:
   * https://docs.temporal.io/visibility
   */
  async count(query: string): Promise<CountActivityExecutions> {
    return await this.interceptedHandlers.count({
      query,
      headers: {},
    });
  }

  protected createHandle<R>(activityId: string, runId?: string): ActivityHandle<R> {
    if (!activityId) {
      throw new TypeError('activityId is required');
    }

    const handle = {
      client: this,
      activityId,
      runId,

      async result(): Promise<R> {
        return await this.client.interceptedHandlers.getResult({
          activityId: this.activityId,
          activityRunId: this.runId ?? '',
          headers: {},
        });
      },

      async describe(): Promise<ActivityExecutionDescription> {
        return await this.client.interceptedHandlers.describe({
          activityId: this.activityId,
          activityRunId: this.runId ?? '',
          headers: {},
        });
      },

      async cancel(reason: string): Promise<void> {
        return await this.client.interceptedHandlers.cancel({
          activityId: this.activityId,
          activityRunId: this.runId ?? '',
          reason,
          headers: {},
        });
      },

      async terminate(reason: string): Promise<void> {
        return await this.client.interceptedHandlers.terminate({
          activityId: this.activityId,
          activityRunId: this.runId ?? '',
          reason,
          headers: {},
        });
      },
    };

    return handle;
  }

  protected async startHandler(input: ActivityStartInput): Promise<ActivityHandle> {
    if (!input.activityType) {
      throw new TypeError('activityType is required');
    }
    validateActivityOptions(input.options);

    try {
      const resp = await this.workflowService.startActivityExecution(
        await this.buildStartActivityExecutionRequest(input)
      );
      return this.createHandle(input.options.id, resp.runId);
    } catch (err) {
      if (isGrpcServiceError(err) && err.code === grpcStatus.ALREADY_EXISTS) {
        for (const entry of getGrpcStatusDetails(err) ?? []) {
          if (!entry.type_url || !entry.value) continue;
          if (
            (trimGrpcTypeUrl(entry.type_url) as ErrorDetailsName) ===
            'temporal.api.errordetails.v1.ActivityExecutionAlreadyStartedFailure'
          ) {
            const details = temporal.api.errordetails.v1.ActivityExecutionAlreadyStartedFailure.decode(entry.value);
            throw new ActivityExecutionAlreadyStartedError(
              'Activity execution already started',
              input.options.id,
              details.runId
            );
          }
        }
      }

      this.rethrowGrpcError(err, 'Failed to start activity');
    }
  }

  protected async buildStartActivityExecutionRequest(
    input: ActivityStartInput
  ): Promise<temporal.api.workflowservice.v1.IStartActivityExecutionRequest> {
    const searchAttributes = input.options.typedSearchAttributes
      ? { indexedFields: encodeUnifiedSearchAttributes(undefined, input.options.typedSearchAttributes) }
      : undefined;

    return {
      namespace: this.options.namespace,
      identity: this.options.identity,
      requestId: uuid4(),
      activityId: input.options.id,
      activityType: { name: input.activityType },
      taskQueue: { name: input.options.taskQueue },
      scheduleToCloseTimeout: msOptionalToTs(input.options.scheduleToCloseTimeout),
      scheduleToStartTimeout: msOptionalToTs(input.options.scheduleToStartTimeout),
      startToCloseTimeout: msOptionalToTs(input.options.startToCloseTimeout),
      heartbeatTimeout: msOptionalToTs(input.options.heartbeatTimeout),
      retryPolicy: input.options.retry ? compileRetryPolicy(input.options.retry) : undefined,
      input: { payloads: await encodeToPayloads(this.dataConverter, ...(input.options.args || [])) },
      idReusePolicy: encodeActivityIdReusePolicy(input.options.idReusePolicy),
      idConflictPolicy: encodeActivityIdConflictPolicy(input.options.idConflictPolicy),
      searchAttributes,
      header: { fields: input.headers },
      userMetadata: await encodeUserMetadata(this.dataConverter, input.options.summary, undefined),
      priority: input.options.priority ? compilePriority(input.options.priority) : undefined,
    };
  }

  protected async getResultHandler(input: ActivityGetResultInput): Promise<any> {
    if (!input.activityId) {
      throw new TypeError('activityId is required');
    }

    const req: temporal.api.workflowservice.v1.IPollActivityExecutionRequest = {
      namespace: this.options.namespace,
      activityId: input.activityId,
      runId: input.activityRunId || undefined,
    };
    for (;;) {
      let failedErr;

      try {
        const resp = await this.workflowService.pollActivityExecution(req);
        if (resp.outcome?.result) {
          const [result] = await decodeArrayFromPayloads(this.dataConverter, resp.outcome.result.payloads ?? []);
          return result;
        } else if (resp.outcome?.failure) {
          // If error conversion throws an exception, we want it to be caught and handled by rethrowGrpcError().
          // If it succeeds, we want to throw the ActivityExecutionFailedError directly, so outside of try/catch.
          failedErr = new ActivityExecutionFailedError(
            'Activity execution failed',
            await decodeOptionalFailureToOptionalError(this.dataConverter, resp.outcome.failure),
            input.activityId,
            resp.runId || input.activityRunId || undefined
          );
        }
      } catch (err) {
        this.rethrowGrpcError(err, 'Failed to get activity result');
      }

      if (failedErr) {
        throw failedErr;
      }
    }
  }

  protected async describeHandler(input: ActivityDescribeInput): Promise<ActivityExecutionDescription> {
    if (!input.activityId) {
      throw new TypeError('activityId is required');
    }

    try {
      const resp = await this.workflowService.describeActivityExecution({
        namespace: this.options.namespace,
        activityId: input.activityId,
        runId: input.activityRunId || undefined,
      });
      return buildActivityDescription(resp.info!, this.dataConverter);
    } catch (err) {
      this.rethrowGrpcError(err, 'Failed to describe activity');
    }
  }

  protected async cancelHandler(input: ActivityCancelInput): Promise<void> {
    if (!input.activityId) {
      throw new TypeError('activityId is required');
    }

    try {
      await this.workflowService.requestCancelActivityExecution({
        namespace: this.options.namespace,
        activityId: input.activityId,
        runId: input.activityRunId || undefined,
        identity: this.options.identity,
        requestId: uuid4(),
        reason: input.reason || undefined,
      });
    } catch (err) {
      this.rethrowGrpcError(err, 'Failed to request activity cancellation');
    }
  }

  protected async terminateHandler(input: ActivityTerminateInput): Promise<void> {
    if (!input.activityId) {
      throw new TypeError('activityId is required');
    }

    try {
      await this.workflowService.terminateActivityExecution({
        namespace: this.options.namespace,
        activityId: input.activityId,
        runId: input.activityRunId || undefined,
        identity: this.options.identity,
        requestId: uuid4(),
        reason: input.reason || undefined,
      });
    } catch (err) {
      this.rethrowGrpcError(err, 'Failed to terminate activity');
    }
  }

  protected async *listHandler(input: ActivityListInput): AsyncIterable<ActivityExecutionInfo> {
    let nextPageToken: Uint8Array | null | undefined = undefined;
    do {
      try {
        const resp: temporal.api.workflowservice.v1.IListActivityExecutionsResponse =
          await this.workflowService.listActivityExecutions({
            namespace: this.options.namespace,
            query: input.query,
            nextPageToken,
          });

        for (const info of resp.executions ?? []) {
          yield buildActivityExecutionInfo(info);
        }
        nextPageToken = resp.nextPageToken;
      } catch (e) {
        this.rethrowGrpcError(e, 'Failed to list activities');
      }
    } while (nextPageToken && nextPageToken.length > 0);
  }

  protected async countHandler(input: ActivityCountInput): Promise<CountActivityExecutions> {
    try {
      const resp = await this.workflowService.countActivityExecutions({
        namespace: this.options.namespace,
        query: input.query,
      });

      return {
        count: resp.count?.toNumber() ?? 0,
        groups: resp.groups?.map((g) => ({
          count: g.count?.toNumber() ?? 0,
          groupValues: g.groupValues?.map((v) => searchAttributePayloadConverter.fromPayload(v)),
        })),
      };
    } catch (err) {
      this.rethrowGrpcError(err, 'Failed to count activities');
    }
  }

  protected rethrowGrpcError(err: unknown, fallbackMessage: string): never {
    if (isGrpcServiceError(err)) {
      rethrowKnownErrorTypes(err);
      if (err.code === grpcStatus.NOT_FOUND) {
        throw new ActivityNotFoundError(err.details ?? 'Activity not found');
      }
      throw new ServiceError(fallbackMessage, { cause: err });
    }
    throw new ServiceError('Unexpected error while making gRPC request');
  }
}

/**
 * Handle that can be used to perform operations on the associated Activity.
 * Can be obtained by calling {@link ActivityClient.start} or {@link ActivityClient.getHandle}.
 * @template R Result type of the activity. Use {@link ActivityClient.typed} to start activities in a type-safe way.
 */
export interface ActivityHandle<R = any> {
  /**
   * ID of the Activity this handle refers to.
   */
  readonly activityId: string;
  /**
   * Run ID of the specific Activity execution this handle refers to. If empty, this handle refers to the latest
   * execution of the Activity with given ID.
   */
  readonly runId?: string;
  /**
   * Waits until the activity completes. If the activity is successful, returns the result of the activity.
   * If the activity was not successful, throws {@link ActivityExecutionFailedError}. The activity failure is stored in
   * the `cause` field.
   */
  result(): Promise<R>;
  /**
   * Returns information about the Activity execution.
   */
  describe(): Promise<ActivityExecutionDescription>;
  /**
   * Requests cancellation of the Activity execution. Note that cancellations are cooperative and not guaranteed to happen.
   */
  cancel(reason: string): Promise<void>;
  /**
   * Terminates the Activity execution. Note that the worker is not immediately notified of termination and may continue running the activity.
   */
  terminate(reason: string): Promise<void>;
}

/**
 * Options used by {@link ActivityClient.start}.
 */
export interface ActivityOptions {
  /**
   * Activity ID of the started activity. It's recommended to use a meaningful business ID.
   */
  id: string;
  /**
   * Task queue to run this activity on.
   */
  taskQueue: string;
  /**
   * Input arguments to pass to the activity.
   */
  args?: any[] | Readonly<any[]>;
  /**
   * If set, specifies maximum time between successful heartbeats.
   */
  heartbeatTimeout?: Duration;
  /**
   * Controls how Activity is retried. If not set, the server will assign default retry policy.
   */
  retry?: RetryPolicy;
  /**
   * Is set, specifies total time the activity is allowed to run, including retries.
   *
   * Note: it is required to set at least one of {@link startToCloseTimeout} and {@link scheduleToCloseTimeout}.
   */
  startToCloseTimeout?: Duration;
  /**
   * If set, specifies maximum time the activity can wait in the task queue before being picked up by a worker.
   * This timeout is non-retryable.
   */
  scheduleToStartTimeout?: Duration;
  /**
   * If set, specifies maximum time for a single execution attempt. This timeout is retryable.
   *
   * Note: it is required to set at least one of {@link startToCloseTimeout} and {@link scheduleToCloseTimeout}.
   */
  scheduleToCloseTimeout?: Duration;
  /**
   * A single-line fixed summary for this activity execution that may appear in UI/CLI.
   * This can be in single-line Temporal markdown format.
   */
  summary?: string;
  /**
   * Priority to use when starting this activity.
   */
  priority?: Priority;
  /**
   * Specifies behavior if there's a *closed* activity with the same ID.
   */
  idReusePolicy?: ActivityIdReusePolicy;
  /**
   * Specifies behavior if there's a *running* activity with the same ID. Note that there can only be one running
   * Activity for each Activity ID.
   */
  idConflictPolicy?: ActivityIdConflictPolicy;
  /**
   * Search attributes for the activity.
   */
  typedSearchAttributes?: SearchAttributePair[] | TypedSearchAttributes;
}

function validateActivityOptions(options: ActivityOptions): void {
  if (!options.id) {
    throw new TypeError('id is required');
  }
  if (!options.taskQueue) {
    throw new TypeError('taskQueue is required');
  }
  if (!options.scheduleToCloseTimeout && !options.startToCloseTimeout) {
    throw new TypeError('Either scheduleToCloseTimeout or startToCloseTimeout is required');
  }
}

function buildActivityExecutionInfoCommonPart(
  info: temporal.api.activity.v1.IActivityExecutionListInfo | temporal.api.activity.v1.IActivityExecutionInfo
): ActivityExecutionInfo {
  return {
    activityId: info.activityId!,
    activityRunId: info.runId!,
    activityType: info.activityType!.name!,
    scheduleTime: optionalTsToDate(info.scheduleTime),
    closeTime: optionalTsToDate(info.closeTime),
    status: decodeActivityExecutionStatus(info.status)!,
    typedSearchAttributes: decodeTypedSearchAttributes(info.searchAttributes?.indexedFields),
    taskQueue: info.taskQueue!,
    executionDurationMs: optionalTsToMs(info.executionDuration),
  };
}

function buildActivityExecutionInfo(info: temporal.api.activity.v1.IActivityExecutionListInfo): ActivityExecutionInfo {
  return {
    ...buildActivityExecutionInfoCommonPart(info),
    rawListInfo: info,
  };
}

function buildActivityDescription(
  info: temporal.api.activity.v1.IActivityExecutionInfo,
  dataConverter: LoadedDataConverter
): ActivityExecutionDescription {
  const getHeartbeatDetails: <T>() => Promise<T | undefined> = async <T>() => {
    const payloads = info.heartbeatDetails?.payloads;
    if (payloads && payloads.length > 0) {
      return await decodeFromPayloadsAtIndex<T>(dataConverter, 0, info.heartbeatDetails?.payloads);
    } else {
      return undefined;
    }
  };

  const getLastFailure: () => Promise<Error | undefined> = async () => {
    return await decodeOptionalFailureToOptionalError(dataConverter, info.lastFailure);
  };

  return {
    ...buildActivityExecutionInfoCommonPart(info),
    rawInfo: info,
    runState: decodePendingActivityState(info.runState),
    scheduleToCloseTimeoutMs: optionalTsToMs(info.scheduleToCloseTimeout),
    scheduleToStartTimeoutMs: optionalTsToMs(info.scheduleToStartTimeout),
    startToCloseTimeoutMs: optionalTsToMs(info.startToCloseTimeout),
    heartbeatTimeoutMs: optionalTsToMs(info.heartbeatTimeout),
    retryPolicy: decompileRetryPolicy(info.retryPolicy)!,
    lastHeartbeatTime: optionalTsToDate(info.lastHeartbeatTime),
    lastStartedTime: optionalTsToDate(info.lastStartedTime),
    attempt: info.attempt!,
    expirationTime: optionalTsToDate(info.expirationTime),
    lastWorkerIdentity: info.lastWorkerIdentity || undefined,
    currentRetryIntervalMs: optionalTsToMs(info.currentRetryInterval),
    lastAttemptCompleteTime: optionalTsToDate(info.lastAttemptCompleteTime),
    nextAttemptScheduleTime: optionalTsToDate(info.nextAttemptScheduleTime),
    lastDeploymentVersion: convertDeploymentVersion(info.lastDeploymentVersion),
    priority: decodePriority(info.priority),
    canceledReason: info.canceledReason || undefined,

    getHeartbeatDetails,
    getLastFailure,
  };
}

/**
 * Sub-interface of {@link ActivityClient} that provides a strongly-typed interface for executing Activities.
 * Argument types in the provided options must match the argument types of the specified Activity as defined in provided
 * interface
 * @template T Activity interface
 */
export interface TypedActivityClient<T> {
  start<N extends ActivityName<T>>(
    activity: N,
    options: ActivityOptionsFor<T, N>
  ): Promise<ActivityHandle<ActivityResult<T, N>>>;

  execute<N extends ActivityName<T>>(activity: N, options: ActivityOptionsFor<T, N>): Promise<ActivityResult<T, N>>;
}

/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Contains names of activities extracted from the specified activity interface.
 * @template T Activity interface
 */
export type ActivityName<T> = {
  [N in keyof T & string]: T[N] extends ActivityFunction<any, any> ? N : never;
}[keyof T & string];

/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Extracts argument types of an activity.
 * @template T Activity interface
 * @template N Activity name
 */
export type ActivityArgs<T, N extends ActivityName<T>> = T[N] extends ActivityFunction<infer P, any> ? P : never;

/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Extracts result type of an activity.
 * @template T Activity interface
 * @template N Activity name
 */
export type ActivityResult<T, N extends ActivityName<T>> = T[N] extends ActivityFunction<any, infer R> ? R : never;

/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Represents {@link ActivityOptions} with strongly typed arguments.
 * @template Args Types of activity arguments as an array type.
 */
export type ActivityOptionsWithArgs<Args extends any[]> = Args extends [any, ...any]
  ? Replace<
      ActivityOptions,
      {
        /**
         * Arguments to pass to the Activity
         */
        args: Args | Readonly<Args>;
      }
    >
  : Replace<
      ActivityOptions,
      {
        /**
         * Arguments to pass to the Activity
         */
        args?: Args | Readonly<Args>;
      }
    >;

/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Represents {@link ActivityOptions} with strongly typed arguments matching specified Activity in specified interface.
 * @template T Activity interface
 * @template N Activity name
 */
export type ActivityOptionsFor<T, N extends ActivityName<T>> = ActivityOptionsWithArgs<ActivityArgs<T, N>>;
