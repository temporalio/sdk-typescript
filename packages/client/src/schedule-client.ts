import { status as grpcStatus } from '@grpc/grpc-js';
import {
  compileRetryPolicy,
  DataConverter,
  LoadedDataConverter,
  mapFromPayloads,
  mapToPayloads,
  searchAttributePayloadConverter,
  SearchAttributes,
} from '@temporalio/common';
import { composeInterceptors, Headers } from '@temporalio/common/lib/interceptors';
import {
  encodeMapToPayloads,
  loadDataConverter,
  isLoadedDataConverter,
  encodeToPayloads,
  filterNullAndUndefined,
  decodeMapFromPayloads,
  decodeArrayFromPayloads,
} from '@temporalio/common/lib/internal-non-workflow';
import os from 'os';
import { Connection } from './connection';
import { CreateScheduleInput, ScheduleClientInterceptor } from './interceptors';
import { ConnectionLike, Metadata, WorkflowService } from './types';
import { v4 as uuid4 } from 'uuid';
import { isServerErrorResponse, ServiceError } from './errors';
import {
  Backfill,
  CompiledScheduleOptions,
  CompiledScheduleUpdateOptions,
  IntervalSpecDescription,
  ScheduleSummary,
  ScheduleDescription,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleUpdateOptions,
  ScheduleExecutionActionResult,
  ScheduleExecutionResult,
} from './schedule-types';
import { Replace } from '@temporalio/common/lib/type-helpers';
import { temporal } from '@temporalio/proto';
import {
  msOptionalToTs,
  msToTs,
  optionalDateToTs,
  optionalTsToDate,
  optionalTsToMs,
  tsToDate,
} from '@temporalio/common/lib/time';
import Long from 'long';
import {
  compileScheduleOptions,
  compileUpdatedScheduleOptions,
  decodeOptionalStructuredCalendarSpecs,
  decodeOverlapPolicy,
  encodeOptionalStructuredCalendarSpecs,
  encodeOverlapPolicy,
  encodeSchedule,
} from './schedule-helpers';

type CreateScheduleRequest = temporal.api.workflowservice.v1.ICreateScheduleRequest;
// type CreateScheduleResponse = temporal.api.workflowservice.v1.ICreateScheduleResponse;
type DescribeScheduleRequest = temporal.api.workflowservice.v1.IDescribeScheduleRequest;
type DescribeScheduleResponse = temporal.api.workflowservice.v1.IDescribeScheduleResponse;
type DeleteScheduleRequest = temporal.api.workflowservice.v1.IDeleteScheduleRequest;
type DeleteScheduleResponse = temporal.api.workflowservice.v1.IDeleteScheduleResponse;
type UpdateScheduleRequest = temporal.api.workflowservice.v1.IUpdateScheduleRequest;
type UpdateScheduleResponse = temporal.api.workflowservice.v1.IUpdateScheduleResponse;
type PatchScheduleRequest = temporal.api.workflowservice.v1.IPatchScheduleRequest;
type PatchScheduleResponse = temporal.api.workflowservice.v1.IPatchScheduleResponse;
type ListSchedulesRequest = temporal.api.workflowservice.v1.IListSchedulesRequest;
type ListSchedulesResponse = temporal.api.workflowservice.v1.IListSchedulesResponse;

/**
 * Handle to a single Schedule
 *
 * @experimental
 */
export interface ScheduleHandle {
  /**
   * This Schedule's identifier
   */
  readonly scheduleId: string;

  /**
   * Fetch the Schedule's description from the Server
   */
  describe(): Promise<ScheduleDescription>;

  /**
   * Update the Schedule
   *
   * This function calls `.describe()`, provides the `Schedule` to the provided `updateFn`, and
   * sends the returned `UpdatedSchedule` to the Server to update the Schedule definition. Note that,
   * in the future, `updateFn` might be invoked multiple time, with identical or different input.
   */
  update(updateFn: (previous: ScheduleDescription) => ScheduleUpdateOptions): Promise<void>;

  /**
   * Delete the Schedule
   */
  delete(): Promise<void>;

  /**
   * Trigger an Action to be taken immediately
   *
   * @param overlap Override the Overlap Policy for this one trigger. Defaults to {@link ScheduleOverlapPolicy.ALLOW_ALL}.
   */
  trigger(overlap?: ScheduleOverlapPolicy): Promise<void>;

  /**
   * Run though the specified time period(s) and take Actions as if that time passed by right now, all at once. The
   * Overlap Policy can be overridden for the scope of the Backfill.
   */
  backfill(options: Backfill | Backfill[]): Promise<void>;

  /**
   * Pause the Schedule
   *
   * @param note A new {@link ScheduleDescription.note}. Defaults to `"Paused via TypeScript SDK"`
   * @throws {@link ValueError} if empty string is passed
   */
  pause(note?: string): Promise<void>;

  /**
   * Unpause the Schedule
   *
   * @param note A new {@link ScheduleDescription.note}. Defaults to `"Unpaused via TypeScript SDK"`
   * @throws {@link ValueError} if empty string is passed
   */
  unpause(note?: string): Promise<void>;

  /**
   * Readonly accessor to the underlying ScheduleClient
   */
  readonly client: ScheduleClient;
}

/**
 * @experimental
 */
export interface ScheduleClientOptions {
  /**
   * {@link DataConverter} to use for serializing and deserializing payloads
   */
  dataConverter?: DataConverter | LoadedDataConverter;

  /**
   * Used to override and extend default Connection functionality
   *
   * Useful for injecting auth headers and tracing Workflow executions
   */
  interceptors?: ScheduleClientInterceptor[];

  /**
   * Identity to report to the server
   *
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;

  /**
   * Connection to use to communicate with the server.
   *
   * By default `ScheduleClient` connects to localhost.
   *
   * Connections are expensive to construct and should be reused.
   */
  connection?: ConnectionLike;

  /**
   * Server namespace
   *
   * @default default
   */
  namespace?: string;
}

/** @experimental */
export type ScheduleClientOptionsWithDefaults = Replace<
  Required<ScheduleClientOptions>,
  {
    connection?: ConnectionLike;
  }
>;

/** @experimental */
export type LoadedScheduleClientOptions = ScheduleClientOptionsWithDefaults & {
  loadedDataConverter: LoadedDataConverter;
};

function defaultScheduleClientOptions(): ScheduleClientOptionsWithDefaults {
  return {
    dataConverter: {},
    // The equivalent in Java is ManagementFactory.getRuntimeMXBean().getName()
    identity: `${process.pid}@${os.hostname()}`,
    interceptors: [],
    namespace: 'default',
  };
}

function assertRequiredScheduleOptions(opts: ScheduleOptions, action: 'CREATE'): void;
function assertRequiredScheduleOptions(opts: CompiledScheduleUpdateOptions, action: 'UPDATE'): void;
function assertRequiredScheduleOptions(
  opts: ScheduleOptions | CompiledScheduleUpdateOptions,
  action: 'CREATE' | 'UPDATE'
): void {
  const structureName = action === 'CREATE' ? 'ScheduleOptions' : 'UpdatedSchedule';
  if (action === 'CREATE' && !(opts as ScheduleOptions).scheduleId) {
    throw new TypeError(`Missing ${structureName}.scheduleId`);
  }
  if (!(opts.spec.calendars?.length || opts.spec.intervals?.length || opts.spec.cronExpressions?.length)) {
    throw new TypeError(`At least one ${structureName}.spec.calendars, .intervals or .cronExpressions is required`);
  }
  switch (opts.action.type) {
    case 'startWorkflow':
      if (!opts.action.taskQueue) {
        throw new TypeError(`Missing ${structureName}.action.taskQueue for 'startWorkflow' action`);
      }
      if (!opts.action.workflowId) {
        throw new TypeError(`Missing ${structureName}.action.workflowId for 'startWorkflow' action`);
      }
      if (!opts.action.workflowType) {
        throw new TypeError(`Missing ${structureName}.action.workflowType for 'startWorkflow' action`);
      }
  }
}

interface ScheduleHandleOptions {
  scheduleId: string;
}

/** @experimental */
export interface ListScheduleOptions {
  /**
   * How many results to fetch from the Server at a time.
   * @default 1000
   */
  pageSize?: number;
}

/**
 * Client for starting Workflow executions and creating Workflow handles
 *
 * @experimental
 */
export class ScheduleClient {
  public readonly options: LoadedScheduleClientOptions;
  public readonly connection: ConnectionLike;

  constructor(options?: ScheduleClientOptions) {
    this.connection = options?.connection ?? Connection.lazy();
    const dataConverter = options?.dataConverter;
    const loadedDataConverter = isLoadedDataConverter(dataConverter) ? dataConverter : loadDataConverter(dataConverter);
    this.options = {
      ...defaultScheduleClientOptions(),
      ...filterNullAndUndefined(options ?? {}),
      loadedDataConverter,
    };
  }

  /**
   * Raw gRPC access to the Temporal service. Schedule-related methods are included in {@link WorkflowService}.
   *
   * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests made to the service.
   */
  get workflowService(): WorkflowService {
    return this.connection.workflowService;
  }

  protected get dataConverter(): LoadedDataConverter {
    return this.options.loadedDataConverter;
  }

  /**
   * Set the deadline for any service requests executed in `fn`'s scope.
   */
  async withDeadline<R>(deadline: number | Date, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withDeadline(deadline, fn);
  }

  /**
   * Set metadata for any service requests executed in `fn`'s scope.
   *
   * @returns returned value of `fn`
   *
   * @see {@link Connection.withMetadata}
   */
  async withMetadata<R>(metadata: Metadata, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withMetadata(metadata, fn);
  }

  /**
   * Create a new Schedule.
   *
   * @throws {@link ScheduleAlreadyRunning} if there's a running (not deleted) Schedule with the given `id`
   * @returns a ScheduleHandle to the created Schedule
   */
  public async create(options: ScheduleOptions): Promise<ScheduleHandle> {
    const { scheduleId } = options;
    await this._createSchedule(options);
    return this._createScheduleHandle({ scheduleId });
  }

  /**
   * Create a new Schedule.
   *
   * @returns ???
   */
  protected async _createSchedule(options: ScheduleOptions): Promise<Uint8Array> {
    assertRequiredScheduleOptions(options, 'CREATE');
    const compiledOptions = compileScheduleOptions(options);

    const create = composeInterceptors(this.options.interceptors, 'create', this._createScheduleHandler.bind(this));
    return create({
      options: compiledOptions,
      headers: {},
    });
  }

  /**
   * Create a new Schedule.
   *
   * @returns ???
   */
  protected async _createScheduleHandler(input: CreateScheduleInput): Promise<Uint8Array> {
    const { options: opts, headers } = input;
    const { identity } = this.options;
    const req: CreateScheduleRequest = {
      namespace: this.options.namespace,
      identity,
      requestId: uuid4(),
      scheduleId: opts.scheduleId,
      schedule: await encodeSchedule(this.dataConverter, opts, headers),
      // FIXME-JWH: The following fields are not updatable
      memo: opts.memo ? { fields: await encodeMapToPayloads(this.dataConverter, opts.memo) } : undefined,
      searchAttributes: opts.searchAttributes
        ? {
            indexedFields: mapToPayloads(searchAttributePayloadConverter, opts.searchAttributes),
          }
        : undefined,
      initialPatch: {
        pause: opts.state?.paused ? 'Paused via TypeScript SDK"' : undefined,
        triggerImmediately: opts.state?.triggerImmediately
          ? { overlapPolicy: temporal.api.enums.v1.ScheduleOverlapPolicy.SCHEDULE_OVERLAP_POLICY_ALLOW_ALL }
          : undefined,
        backfillRequest: opts.state?.backfill
          ? opts.state.backfill.map((x) => ({
              startTime: optionalDateToTs(x.start),
              endTime: optionalDateToTs(x.end),
              overlapPolicy: x.overlap ? encodeOverlapPolicy(x.overlap) : undefined,
            }))
          : undefined,
      },
    };
    try {
      const res = await this.workflowService.createSchedule(req);
      return res.conflictToken;
    } catch (err: any) {
      if (err.code === grpcStatus.ALREADY_EXISTS) {
        throw new ScheduleAlreadyRunning('Schedule already exists and is running', opts.scheduleId);
      }
      this.rethrowGrpcError(err, opts.scheduleId, 'Failed to create schedule');
    }
  }

  /**
   * Describe a Schedule.
   *
   * @returns ???
   */
  protected async _describeSchedule(scheduleId: string): Promise<DescribeScheduleResponse> {
    try {
      return await this.workflowService.describeSchedule({
        namespace: this.options.namespace,
        scheduleId,
      });
    } catch (err: any) {
      this.rethrowGrpcError(err, scheduleId, 'Failed to describe schedule');
    }
  }

  /**
   * Update a Schedule.
   *
   * @returns ???
   */
  protected async _updateSchedule(
    scheduleId: string,
    schedule: CompiledScheduleUpdateOptions
  ): Promise<UpdateScheduleResponse> {
    assertRequiredScheduleOptions(schedule, 'UPDATE');
    try {
      return await this.workflowService.updateSchedule({
        namespace: this.options.namespace,
        scheduleId,

        schedule: await encodeSchedule(this.dataConverter, schedule),

        identity: this.options.identity,
        requestId: uuid4(),
      });
    } catch (err: any) {
      this.rethrowGrpcError(err, scheduleId, 'Failed to update schedule');
    }
  }

  /**
   * Patch a Schedule.
   *
   * @returns ???
   */
  protected async _patchSchedule(
    scheduleId: string,
    patch: temporal.api.schedule.v1.ISchedulePatch
  ): Promise<PatchScheduleResponse> {
    try {
      return await this.workflowService.patchSchedule({
        namespace: this.options.namespace,
        scheduleId,
        identity: this.options.identity,
        requestId: uuid4(),
        patch,
      });
    } catch (err: any) {
      this.rethrowGrpcError(err, scheduleId, 'Failed to patch schedule');
    }
  }

  /**
   * Delete a Schedule.
   *
   * @returns ???
   */
  protected async _deleteSchedule(scheduleId: string): Promise<DeleteScheduleResponse> {
    try {
      return await this.workflowService.deleteSchedule({
        namespace: this.options.namespace,
        identity: this.options.identity,
        scheduleId,
      });
    } catch (err: any) {
      this.rethrowGrpcError(err, scheduleId, 'Failed to delete schedule');
    }
  }

  /**
   * List Schedules with an `AsyncIterator`:
   *
   * ```ts
   * for await (const schedule: Schedule of client.list()) {
   *   const { id, memo, searchAttributes } = schedule
   *   // ...
   * }
   * ```
   *
   * To list one page at a time, instead use the raw gRPC method {@link WorkflowService.listSchedules}:
   *
   * ```ts
   * await { schedules, nextPageToken } = client.scheduleService.listSchedules()
   * ```
   */
  public async *list(options?: ListScheduleOptions): AsyncIterable<ScheduleSummary> {
    let nextPageToken: Uint8Array | undefined = undefined;
    for (;;) {
      const response: ListSchedulesResponse = await this.workflowService.listSchedules({
        nextPageToken,
        namespace: this.options.namespace,
        maximumPageSize: options?.pageSize,
      });

      for (const raw of response.schedules ?? []) {
        yield <ScheduleSummary>{
          scheduleId: raw.scheduleId,

          spec: {
            // Note: the server will have compiled calendar and cron_string fields into
            // structured_calendar (and maybe interval and timezone_name), so at this
            // point, we'll see only structured_calendar, interval, etc.
            calendars: decodeOptionalStructuredCalendarSpecs(raw.info?.spec?.structuredCalendar),
            intervals: (raw.info?.spec?.interval ?? []).map(
              (x) =>
                <IntervalSpecDescription>{
                  every: optionalTsToMs(x.interval),
                  offset: optionalTsToMs(x.phase),
                }
            ),
            skip: decodeOptionalStructuredCalendarSpecs(raw.info?.spec?.excludeStructuredCalendar),
            startAt: optionalTsToDate(raw.info?.spec?.startTime),
            endAt: optionalTsToDate(raw.info?.spec?.endTime),
            jitter: optionalTsToMs(raw.info?.spec?.jitter),
          },
          action: {
            type: 'startWorkflow',
            workflowType: raw.info?.workflowType?.name,
          },
          memo: await decodeMapFromPayloads(this.dataConverter, raw.memo?.fields),
          searchAttributes: Object.fromEntries(
            Object.entries(
              mapFromPayloads(
                searchAttributePayloadConverter,
                raw.searchAttributes?.indexedFields ?? {}
              ) as SearchAttributes
            ).filter(([_, v]) => v && v.length > 0) // Filter out empty arrays returned by pre 1.18 servers
          ),
          state: {
            paused: !!raw.info?.paused,
            note: raw.info?.notes,
          },
          info: {
            recentActions:
              raw.info?.recentActions?.map(
                (x): ScheduleExecutionResult => ({
                  scheduledAt: tsToDate(x.scheduleTime!),
                  takenAt: tsToDate(x.actualTime!),
                  action: {
                    type: 'startWorkflow',
                    workflow: {
                      workflowId: x.startWorkflowResult!.workflowId!,
                      firstExecutionRunId: x.startWorkflowResult!.runId!,
                    },
                  },
                })
              ) ?? [],
            nextActionTimes: raw.info?.futureActionTimes?.map(tsToDate) ?? [],
          },
        };
      }

      if (response.nextPageToken == null || response.nextPageToken.length === 0) break;
      nextPageToken = response.nextPageToken;
    }
  }

  /**
   * Get a handle to a Schedule
   *
   * This method does not validate `scheduleId`. If there is no Schedule with the given `scheduleId`, handle
   * methods like `handle.describe()` will throw a {@link ScheduleNotFoundError} error.
   */
  public getHandle(scheduleId: string): ScheduleHandle {
    return this._createScheduleHandle({ scheduleId });
  }

  /**
   * Create a new schedule handle for new or existing Schedule
   */
  protected _createScheduleHandle({ scheduleId }: ScheduleHandleOptions): ScheduleHandle {
    return {
      client: this,
      scheduleId,

      async describe(): Promise<ScheduleDescription> {
        const raw = await this.client._describeSchedule(this.scheduleId);
        return {
          scheduleId,
          spec: {
            // Note: the server will have compiled calendar and cron_string fields into
            // structured_calendar (and maybe interval and timezone_name), so at this
            // point, we'll see only structured_calendar, interval, etc.
            calendars: decodeOptionalStructuredCalendarSpecs(raw.schedule?.spec?.structuredCalendar),
            intervals: (raw.schedule?.spec?.interval ?? []).map(
              (x) =>
                <IntervalSpecDescription>{
                  every: optionalTsToMs(x.interval),
                  offset: optionalTsToMs(x.phase),
                }
            ),
            skip: decodeOptionalStructuredCalendarSpecs(raw.schedule?.spec?.excludeStructuredCalendar),
            startAt: optionalTsToDate(raw.schedule?.spec?.startTime),
            endAt: optionalTsToDate(raw.schedule?.spec?.endTime),
            jitter: optionalTsToMs(raw.schedule?.spec?.jitter),
          },
          action: {
            type: 'startWorkflow',
            /* eslint-disable @typescript-eslint/no-non-null-assertion */
            workflowId: raw.schedule!.action!.startWorkflow!.workflowId!,
            workflowType: raw.schedule!.action!.startWorkflow!.workflowType!.name!,
            taskQueue: raw.schedule!.action!.startWorkflow!.taskQueue!.name!,
            args: await decodeArrayFromPayloads(
              this.client.dataConverter,
              raw.schedule!.action!.startWorkflow!.input!.payloads
            ),
            memo: await decodeMapFromPayloads(
              this.client.dataConverter,
              raw.schedule!.action!.startWorkflow!.memo?.fields
            ),
            retry: raw.schedule!.action!.startWorkflow!.retryPolicy
              ? {
                  backoffCoefficient: raw.schedule!.action!.startWorkflow!.retryPolicy!.backoffCoefficient!,
                  initialInterval: optionalTsToMs(raw.schedule!.action!.startWorkflow!.retryPolicy!.initialInterval),
                  maximumInterval: optionalTsToMs(raw.schedule!.action!.startWorkflow!.retryPolicy!.maximumInterval),
                  maximumAttempts: raw.schedule!.action!.startWorkflow!.retryPolicy!.maximumAttempts!,
                  nonRetryableErrorTypes: raw.schedule!.action!.startWorkflow!.retryPolicy!.nonRetryableErrorTypes!,
                }
              : undefined,
            searchAttributes: Object.fromEntries(
              Object.entries(
                mapFromPayloads(
                  searchAttributePayloadConverter,
                  raw.schedule!.action!.startWorkflow!.searchAttributes?.indexedFields ?? {}
                ) as SearchAttributes
              ).filter(([_, v]) => v && v.length > 0) // Filter out empty arrays returned by pre 1.18 servers
            ),
            workflowExecutionTimeout: optionalTsToMs(raw.schedule!.action!.startWorkflow!.workflowExecutionTimeout),
            workflowRunTimeout: optionalTsToMs(raw.schedule!.action!.startWorkflow!.workflowRunTimeout),
            workflowTaskTimeout: optionalTsToMs(raw.schedule!.action!.startWorkflow!.workflowTaskTimeout),
          },
          memo: await decodeMapFromPayloads(this.client.dataConverter, raw.memo?.fields),
          searchAttributes: Object.fromEntries(
            Object.entries(
              mapFromPayloads(
                searchAttributePayloadConverter,
                raw.searchAttributes?.indexedFields ?? {}
              ) as SearchAttributes
            ).filter(([_, v]) => v && v.length > 0) // Filter out empty arrays returned by pre 1.18 servers
          ),
          policies: {
            overlap: decodeOverlapPolicy(raw.schedule!.policies!.overlapPolicy!),
            catchupWindow: optionalTsToMs(raw.schedule!.policies!.catchupWindow) ?? 60000, // FIXME: Server size normalization
            pauseOnFailure: !!raw.schedule!.policies!.pauseOnFailure,
          },
          state: {
            paused: !!raw.schedule?.state?.paused,
            remainingActions: raw.schedule?.state?.limitedActions
              ? raw.schedule?.state?.remainingActions?.toNumber() || 0
              : undefined,
            note: raw.schedule!.state!.notes!,
          },
          info: {
            createdAt: tsToDate(raw.info!.createTime!),
            lastUpdatedAt: optionalTsToDate(raw.info!.updateTime!),
            runningActions:
              raw.info!.runningWorkflows?.map(
                (x): ScheduleExecutionActionResult => ({
                  type: 'startWorkflow',
                  workflow: {
                    workflowId: x.workflowId!,
                    firstExecutionRunId: x.runId!,
                  },
                })
              ) ?? [],
            recentActions:
              raw.info?.recentActions?.map(
                (x): ScheduleExecutionResult => ({
                  scheduledAt: tsToDate(x.scheduleTime!),
                  takenAt: tsToDate(x.actualTime!),
                  action: {
                    type: 'startWorkflow',
                    workflow: {
                      workflowId: x.startWorkflowResult!.workflowId!,
                      firstExecutionRunId: x.startWorkflowResult!.runId!,
                    },
                  },
                })
              ) ?? [],
            nextActionTimes: raw.info!.futureActionTimes!.map(tsToDate) ?? [],
            numActionsMissedCatchupWindow: raw.info!.missedCatchupWindow!.toNumber(),
            numActionsSkippedOverlap: raw.info!.overlapSkipped!.toNumber(),
            numActionsTaken: raw.info!.actionCount!.toNumber(),
          },
          raw,
        };
      },

      async update(updateFn): Promise<void> {
        const actual = await this.describe();
        const updated = updateFn(actual);
        await this.client._updateSchedule(scheduleId, compileUpdatedScheduleOptions(updated));
      },

      async delete(): Promise<void> {
        await this.client._deleteSchedule(this.scheduleId);
      },

      async pause(note?: string): Promise<void> {
        await this.client._patchSchedule(this.scheduleId, {
          pause: note ?? 'Paused via TypeScript SDK"',
        });
      },

      async unpause(note?): Promise<void> {
        await this.client._patchSchedule(this.scheduleId, {
          unpause: note ?? 'Unpaused via TypeScript SDK"',
        });
      },

      async trigger(overlap?): Promise<void> {
        await this.client._patchSchedule(this.scheduleId, {
          triggerImmediately: {
            overlapPolicy: overlap
              ? encodeOverlapPolicy(overlap)
              : temporal.api.enums.v1.ScheduleOverlapPolicy.SCHEDULE_OVERLAP_POLICY_ALLOW_ALL,
          },
        });
      },

      async backfill(options): Promise<void> {
        const backfills = Array.isArray(options) ? options : [options];
        await this.client._patchSchedule(this.scheduleId, {
          backfillRequest: backfills.map((x) => ({
            startTime: optionalDateToTs(x.start),
            endTime: optionalDateToTs(x.end),
            overlapPolicy: x.overlap ? encodeOverlapPolicy(x.overlap) : undefined,
          })),
        });
      },
    };
  }

  protected rethrowGrpcError(err: unknown, scheduleId: string, fallbackMessage: string): never {
    if (isServerErrorResponse(err)) {
      if (err.code === grpcStatus.NOT_FOUND) {
        throw new ScheduleNotFoundError(err.details ?? 'Schedule not found', scheduleId);
      }
      if (
        err.code === grpcStatus.INVALID_ARGUMENT &&
        err.message.match(/^3 INVALID_ARGUMENT: Invalid schedule spec: /)
      ) {
        throw new TypeError(err.message.replace(/^3 INVALID_ARGUMENT: Invalid schedule spec: /, ''));
      }
      throw new ServiceError(fallbackMessage, { cause: err });
    }
    throw new ServiceError('Unexpected error while making gRPC request');
  }
}

/**
 * Thrown from {@link ScheduleClient.create} if there's a running (not deleted) Schedule with the given `id`.
 *
 * @experimental
 */
export class ScheduleAlreadyRunning extends Error {
  public readonly name: string = 'ScheduleAlreadyRunning';

  constructor(message: string, public readonly scheduleId: string) {
    super(message);
  }
}

/**
 * Thrown when a Schedule with the given Id is not known to Temporal Server.
 * It could be because:
 * - Id passed is incorrect
 * - Schedule was deleted
 *
 * @experimental
 */
export class ScheduleNotFoundError extends Error {
  public readonly name: string = 'ScheduleNotFoundError';

  constructor(message: string, public readonly scheduleId: string) {
    super(message);
  }
}
