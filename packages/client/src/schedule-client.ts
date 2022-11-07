import { status as grpcStatus } from '@grpc/grpc-js';
import {
  compileRetryPolicy,
  DataConverter,
  LoadedDataConverter,
  mapFromPayloads,
  mapToPayloads,
  searchAttributePayloadConverter,
  SearchAttributes,
  Workflow,
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
import { CreateScheduleInput, ScheduleClientCallsInterceptor, ScheduleClientInterceptors } from './interceptors';
import { ConnectionLike, Metadata, WorkflowService } from './types';
import { v4 as uuid4 } from 'uuid';
import { isServerErrorResponse, ServiceError } from './errors';
import {
  Backfill,
  CalendarSpec,
  CalendarSpecDescription,
  CompiledScheduleOptions,
  CompiledUpdatedSchedule,
  compileScheduleOptions,
  compileUpdatedScheduleOptions,
  dayOfWeekNameToNumber,
  dayOfWeekNumberToName,
  IntervalSpecDescription,
  ListScheduleEntry,
  ListScheduleOptions,
  monthNameToNumber,
  monthNumberToName,
  Range,
  Schedule,
  ScheduleActionType,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  UpdatedSchedule,
  UpdateScheduleOptions,
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

// FIXME: Determine if we want to support these
type ListScheduleMatchingTimesRequest = temporal.api.workflowservice.v1.IListScheduleMatchingTimesRequest;
type ListScheduleMatchingTimesResponse = temporal.api.workflowservice.v1.IListScheduleMatchingTimesResponse;

/**
 * Handle to a single Schedule
 */
export interface ScheduleHandle {
  /**
   * This Schedule's identifier
   */
  readonly scheduleId: string;

  /**
   * Fetch the Schedule's description from the Server
   */
  describe(): Promise<Schedule>;

  /**
   * Update the Schedule
   *
   * Apply a user update function to the current schedule definition, and then try to update the
   * schedule definition on the server. Note that, in the future, the user provided function might
   * be invoked multiple time, with identical or different input.
   *
   * WARNING: At this moment, the server provides no garantee that update was applied sucessfully.
   */
  update<Action extends Workflow = Workflow>(updateFn: (previous: Schedule) => UpdatedSchedule<Action>): Promise<void>;

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
   * @param note A new {@link Schedule.note}. Defaults to `"Paused via TypeScript SDK"`
   * @throws {@link ValueError} if empty string is passed
   */
  pause(note?: string): Promise<void>;

  /**
   * Unpause the Schedule
   *
   * @param note A new {@link Schedule.note}. Defaults to `"Unpaused via TypeScript SDK"`
   * @throws {@link ValueError} if empty string is passed
   */
  unpause(note?: string): Promise<void>;

  /**
   * Readonly accessor to the underlying ScheduleClient
   */
  readonly client: ScheduleClient;
}

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
  interceptors?: ScheduleClientInterceptors;

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

export type ScheduleClientOptionsWithDefaults = Replace<
  Required<ScheduleClientOptions>,
  {
    connection?: ConnectionLike;
  }
>;
export type LoadedScheduleClientOptions = ScheduleClientOptionsWithDefaults & {
  loadedDataConverter: LoadedDataConverter;
};

export function defaultScheduleClientOptions(): ScheduleClientOptionsWithDefaults {
  return {
    dataConverter: {},
    // The equivalent in Java is ManagementFactory.getRuntimeMXBean().getName()
    identity: `${process.pid}@${os.hostname()}`,
    interceptors: {},
    namespace: 'default',
  };
}

// FIXME: assertRequiredScheduleOptions

interface ScheduleHandleOptions {
  scheduleId: string;
  interceptors: ScheduleClientCallsInterceptor[];
}

/**
 * Client for starting Workflow executions and creating Workflow handles
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
  get scheduleService(): WorkflowService {
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
  public async create<Action extends ScheduleActionType>(options: ScheduleOptions<Action>): Promise<ScheduleHandle> {
    const { scheduleId } = options;
    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) => ctor({ scheduleId }));

    await this._createSchedule(options, interceptors);
    return this._createScheduleHandle({ scheduleId, interceptors });
  }

  /**
   * Create a new Schedule.
   *
   * @returns ???
   */
  protected async _createSchedule<Action extends ScheduleActionType>(
    options: ScheduleOptions<Action>,
    interceptors: ScheduleClientCallsInterceptor[]
  ): Promise<Uint8Array> {
    // assertRequiredScheduleOptions(options);
    const compiledOptions = compileScheduleOptions(options);

    const create = composeInterceptors(interceptors, 'create', this._createScheduleHandler.bind(this));
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
      schedule: await this.encodeSchedule(opts, headers),
      // FIXME-JWH: The following fields are not updatable
      memo: opts.memo ? { fields: await encodeMapToPayloads(this.dataConverter, opts.memo) } : undefined,
      searchAttributes: opts.searchAttributes
        ? {
            indexedFields: mapToPayloads(searchAttributePayloadConverter, opts.searchAttributes),
          }
        : undefined,
      initialPatch: {
        pause: opts.paused ? 'Paused via TypeScript SDK"' : undefined,
        triggerImmediately: opts.triggerImmediately
          ? { overlapPolicy: temporal.api.enums.v1.ScheduleOverlapPolicy.SCHEDULE_OVERLAP_POLICY_ALLOW_ALL }
          : undefined,
        backfillRequest: opts.backfill
          ? opts.backfill.map((x) => ({
              startTime: optionalDateToTs(x.start),
              endTime: optionalDateToTs(x.end),
              overlapPolicy: x.overlap ? encodeOverlapPolicy(x.overlap) : undefined,
            }))
          : undefined,
      },
    };
    try {
      const res = await this.scheduleService.createSchedule(req);
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
      return await this.scheduleService.describeSchedule({
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
    schedule: CompiledUpdatedSchedule
  ): Promise<UpdateScheduleResponse> {
    try {
      return await this.scheduleService.updateSchedule({
        namespace: this.options.namespace,
        scheduleId,

        schedule: await this.encodeSchedule(schedule),

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
      return await this.scheduleService.patchSchedule({
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
      return await this.scheduleService.deleteSchedule({
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
  public async *list(options?: ListScheduleOptions): AsyncIterable<ListScheduleEntry> {
    let nextPageToken: Uint8Array | undefined = undefined;
    for (;;) {
      const response: ListSchedulesResponse = await this.scheduleService.listSchedules({
        nextPageToken,
        namespace: this.options.namespace,
        maximumPageSize: options?.pageSize,
      });

      for (const raw of response.schedules!) {
        yield <ListScheduleEntry>{
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
          workflowType: raw.info?.workflowType?.name,
          memo: await decodeMapFromPayloads(this.dataConverter, raw.memo?.fields),
          searchAttributes: Object.fromEntries(
            Object.entries(
              mapFromPayloads(
                searchAttributePayloadConverter,
                raw.searchAttributes?.indexedFields ?? {}
              ) as SearchAttributes
            ).filter(([_, v]) => v && v.length > 0) // Filter out empty arrays returned by pre 1.18 servers
          ),
          paused: !!raw.info?.paused,
          note: raw.info?.notes,
          recentActions:
            raw.info?.recentActions?.map((x) => ({
              scheduledAt: tsToDate(x.scheduleTime!),
              takenAt: tsToDate(x.actualTime!),
              workflow: {
                workflowId: x.startWorkflowResult!.workflowId!,
                firstExecutionRunId: x.startWorkflowResult!.runId!,
              },
            })) ?? [],
          nextActionTimes: raw.info?.futureActionTimes?.map(tsToDate) ?? [],
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
    // FIXME: Is there any use to pass interceptors here?
    const interceptors = (this.options.interceptors.calls ?? []).map((ctor) => ctor({ scheduleId }));
    return this._createScheduleHandle({ scheduleId, interceptors });
  }

  /**
   * Create a new schedule handle for new or existing Schedule
   */
  protected _createScheduleHandle({ scheduleId /*, interceptors */ }: ScheduleHandleOptions): ScheduleHandle {
    // FIXME: Is there any reason to obtaining interceptors as input here?
    return {
      client: this,
      scheduleId,

      async describe(): Promise<Schedule> {
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
          workflowType: raw.schedule!.action!.startWorkflow!.workflowType!.name!,
          memo: await decodeMapFromPayloads(this.client.dataConverter, raw.memo?.fields),
          searchAttributes: Object.fromEntries(
            Object.entries(
              mapFromPayloads(
                searchAttributePayloadConverter,
                raw.searchAttributes?.indexedFields ?? {}
              ) as SearchAttributes
            ).filter(([_, v]) => v && v.length > 0) // Filter out empty arrays returned by pre 1.18 servers
          ),
          paused: !!raw.schedule?.state?.paused,
          note: raw.schedule!.state!.notes!,
          overlap: decodeOverlapPolicy(raw.schedule!.policies!.overlapPolicy!),
          catchupWindow: optionalTsToMs(raw.schedule!.policies!.catchupWindow),
          pauseOnFailure: !!raw.schedule!.policies!.pauseOnFailure,
          createdAt: tsToDate(raw.info!.createTime!),
          lastUpdatedAt: optionalTsToDate(raw.info!.updateTime!),
          runningWorkflows:
            raw.info!.runningWorkflows?.map((x) => ({
              workflowId: x.workflowId!,
              firstExecutionRunId: x.runId!,
            })) ?? [],
          remainingActions: raw.schedule?.state?.remainingActions?.toNumber(),
          recentActions:
            raw.info?.recentActions?.map((x) => ({
              scheduledAt: tsToDate(x.scheduleTime!),
              takenAt: tsToDate(x.actualTime!),
              workflow: {
                workflowId: x.startWorkflowResult!.workflowId!,
                firstExecutionRunId: x.startWorkflowResult!.runId!,
              },
            })) ?? [],
          nextActionTimes: raw.info!.futureActionTimes!.map(tsToDate) ?? [],
          numActionsMissedCatchupWindow: raw.info!.missedCatchupWindow!.toNumber(),
          numActionsSkippedOverlap: raw.info!.overlapSkipped!.toNumber(),
          numActionsTaken: raw.info!.actionCount!.toNumber(),

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
        throw new InvalidScheduleSpecError(
          err.message.replace(/^3 INVALID_ARGUMENT: Invalid schedule spec: /, ''),
          scheduleId
        );
      }
      throw new ServiceError(fallbackMessage, { cause: err });
    }
    throw new ServiceError('Unexpected error while making gRPC request');
  }

  protected async encodeSchedule(
    opts: CompiledScheduleOptions | CompiledUpdatedSchedule,
    headers?: Headers
  ): Promise<temporal.api.schedule.v1.ISchedule> {
    return {
      spec: {
        structuredCalendar: encodeOptionalStructuredCalendarSpecs(opts.spec.calendars),
        interval: opts.spec.intervals?.map((interval) => ({
          interval: msToTs(interval.every),
          phase: msOptionalToTs(interval.offset),
        })),
        cronString: opts.spec.cronExpressions,
        excludeStructuredCalendar: encodeOptionalStructuredCalendarSpecs(opts.spec.skip),
        startTime: optionalDateToTs(opts.spec.startAt),
        endTime: optionalDateToTs(opts.spec.endAt),
        jitter: msOptionalToTs(opts.spec.jitter),
        timezoneName: opts.spec.timezone,
      },
      action: {
        startWorkflow: {
          workflowId: opts.action.workflowId,
          workflowType: {
            name: opts.action.workflowType,
          },
          input: { payloads: await encodeToPayloads(this.dataConverter, ...opts.action.args) },
          taskQueue: {
            kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
            name: opts.action.taskQueue,
          },
          workflowExecutionTimeout: msOptionalToTs(opts.action.workflowExecutionTimeout),
          workflowRunTimeout: msOptionalToTs(opts.action.workflowRunTimeout),
          workflowTaskTimeout: msOptionalToTs(opts.action.workflowTaskTimeout),
          retryPolicy: opts.action.retry ? compileRetryPolicy(opts.action.retry) : undefined,
          memo: opts.action.memo
            ? { fields: await encodeMapToPayloads(this.dataConverter, opts.action.memo) }
            : undefined,
          searchAttributes: opts.action.searchAttributes
            ? {
                indexedFields: mapToPayloads(searchAttributePayloadConverter, opts.action.searchAttributes),
              }
            : undefined,
          header: { fields: headers },
        },
      },
      policies: {
        catchupWindow: msOptionalToTs(opts.catchupWindow),
        overlapPolicy: opts.overlap ? encodeOverlapPolicy(opts.overlap) : undefined,
        pauseOnFailure: opts.pauseOnFailure,
      },
      state: {
        paused: opts.paused,
        notes: opts.note,
      },
    };
  }
}

/**
 * Thrown from {@link ScheduleClient.create} if there's a running (not deleted) Schedule with the given `id`.
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
 */
export class ScheduleNotFoundError extends Error {
  public readonly name: string = 'ScheduleNotFoundError';

  constructor(message: string, public readonly scheduleId: string) {
    super(message);
  }
}

/**
 * Thrown when a Schedule has an incorrect syntax.
 */
export class InvalidScheduleSpecError extends Error {
  public readonly name: string = 'InvalidScheduleSpecError';

  constructor(message: string, public readonly scheduleId: string) {
    super(message);
  }
}

const calendarSpecFieldEncoders = {
  second: makeCalendarSpecFieldCoders(
    'second',
    (x: number) => (typeof x === 'number' ? x : undefined),
    (x: number) => x,
    [{ start: 0, end: 0, step: 0 }], // default to 0
    [{ start: 0, end: 59, step: 1 }]
  ),
  minute: makeCalendarSpecFieldCoders(
    'minute',
    (x: number) => (typeof x === 'number' ? x : undefined),
    (x: number) => x,
    [{ start: 0, end: 0, step: 0 }], // default to 0
    [{ start: 0, end: 59, step: 1 }]
  ),
  hour: makeCalendarSpecFieldCoders(
    'hour',
    (x: number) => (typeof x === 'number' ? x : undefined),
    (x: number) => x,
    [{ start: 0, end: 0, step: 0 }], // default to 0
    [{ start: 0, end: 23, step: 1 }]
  ),
  dayOfMonth: makeCalendarSpecFieldCoders(
    'dayOfMonth',
    (x: number) => (typeof x === 'number' ? x : undefined),
    (x: number) => x,
    [{ start: 1, end: 31, step: 1 }], // default to *
    [{ start: 1, end: 31, step: 1 }]
  ),
  month: makeCalendarSpecFieldCoders(
    'month',
    monthNameToNumber,
    monthNumberToName,
    [{ start: 1, end: 12, step: 1 }], // default to *
    [{ start: 1, end: 12, step: 1 }]
  ),
  year: makeCalendarSpecFieldCoders(
    'year',
    (x: number) => (typeof x === 'number' ? x : undefined),
    (x: number) => x,
    [], // default to *
    [] // special case: * for years is encoded as no range at all
  ),
  dayOfWeek: makeCalendarSpecFieldCoders(
    'dayOfWeek',
    dayOfWeekNameToNumber,
    dayOfWeekNumberToName,
    [{ start: 0, end: 6, step: 1 }], // default to *
    [{ start: 0, end: 6, step: 1 }]
  ),
};

function makeCalendarSpecFieldCoders<X>(
  field: string,
  encodeValueFn: (x: X) => number | undefined,
  decodeValueFn: (x: number) => X | undefined,
  defaultValue: temporal.api.schedule.v1.IRange[],
  matchAllValue: temporal.api.schedule.v1.IRange[]
) {
  function encoder(
    input: X | Range<X> | (X | Range<X>)[] | '*' | undefined
  ): temporal.api.schedule.v1.IRange[] | undefined {
    if (input === undefined) return defaultValue;
    if (input === '*') return matchAllValue;

    return (Array.isArray(input) ? input : [input]).map((item) => {
      if (typeof item === 'object' && (item as Range<X>).start !== undefined) {
        const range = item as Range<X>;
        const start = encodeValueFn(range.start);
        if (start !== undefined) {
          return {
            start,
            end: range.end !== undefined ? encodeValueFn(range.end) ?? start : 1,
            step: typeof range.step === 'number' && range.step > 0 ? range.step : 1,
          };
        }
      }
      if (item !== undefined) {
        const value = encodeValueFn(item as X);
        if (value !== undefined) return { start: value, end: value, step: 1 };
      }
      throw new Error(`Invalid CalendarSpec component for field ${field}: '${item}' of type '${typeof item}'`);
    });
  }

  function decoder(input: temporal.api.schedule.v1.IRange[] | undefined | null): Range<X>[] {
    if (!input) return [];
    return (
      input.map((x): Range<X> => {
        const start = decodeValueFn(x.start!)!;
        const end = x.end! > x.start! ? decodeValueFn(x.end!) ?? start : start;
        const step = x.step! > 0 ? x.step! : 1;
        return { start, end, step };
      }) ?? undefined
    );
  }

  return { encoder, decoder };
}

function encodeOptionalStructuredCalendarSpecs(
  input: CalendarSpec[] | null | undefined
): temporal.api.schedule.v1.IStructuredCalendarSpec[] | undefined {
  if (!input) return undefined;
  return input.map((spec) => ({
    second: calendarSpecFieldEncoders.second.encoder(spec.second),
    minute: calendarSpecFieldEncoders.minute.encoder(spec.minute),
    hour: calendarSpecFieldEncoders.hour.encoder(spec.hour),
    dayOfMonth: calendarSpecFieldEncoders.dayOfMonth.encoder(spec.dayOfMonth),
    month: calendarSpecFieldEncoders.month.encoder(spec.month),
    year: calendarSpecFieldEncoders.year.encoder(spec.year),
    dayOfWeek: calendarSpecFieldEncoders.dayOfWeek.encoder(spec.dayOfWeek),
    comment: spec.comment,
  }));
}

function decodeOptionalStructuredCalendarSpecs(
  input: temporal.api.schedule.v1.IStructuredCalendarSpec[] | null | undefined
): CalendarSpecDescription[] {
  if (!input) return [];
  return input.map((spec) => ({
    second: calendarSpecFieldEncoders.second.decoder(spec.second),
    minute: calendarSpecFieldEncoders.minute.decoder(spec.minute),
    hour: calendarSpecFieldEncoders.hour.decoder(spec.hour),
    dayOfMonth: calendarSpecFieldEncoders.dayOfMonth.decoder(spec.dayOfMonth),
    month: calendarSpecFieldEncoders.month.decoder(spec.month),
    year: calendarSpecFieldEncoders.year.decoder(spec.year),
    dayOfWeek: calendarSpecFieldEncoders.dayOfWeek.decoder(spec.dayOfWeek),
    comment: spec.comment!,
  }));
}

function encodeOverlapPolicy(input: ScheduleOverlapPolicy): temporal.api.enums.v1.ScheduleOverlapPolicy {
  return temporal.api.enums.v1.ScheduleOverlapPolicy[
    `SCHEDULE_OVERLAP_POLICY_${ScheduleOverlapPolicy[input] as keyof typeof ScheduleOverlapPolicy}`
  ];
}

function decodeOverlapPolicy(input: temporal.api.enums.v1.ScheduleOverlapPolicy): ScheduleOverlapPolicy {
  const encodedPolicyName = temporal.api.enums.v1.ScheduleOverlapPolicy[input];
  const decodedPolicyName = encodedPolicyName.substring(
    'SCHEDULE_OVERLAP_POLICY_'.length
  ) as keyof typeof ScheduleOverlapPolicy;
  return ScheduleOverlapPolicy[decodedPolicyName];
}
