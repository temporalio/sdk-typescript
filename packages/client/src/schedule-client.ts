import { status as grpcStatus } from '@grpc/grpc-js';
import { v4 as uuid4 } from 'uuid';
import { mapToPayloads, searchAttributePayloadConverter, Workflow } from '@temporalio/common';
import { composeInterceptors, Headers } from '@temporalio/common/lib/interceptors';
import {
  encodeMapToPayloads,
  decodeMapFromPayloads,
  filterNullAndUndefined,
} from '@temporalio/common/lib/internal-non-workflow';
import { temporal } from '@temporalio/proto';
import { optionalDateToTs, optionalTsToDate, optionalTsToMs, tsToDate } from '@temporalio/common/lib/time';
import { CreateScheduleInput, CreateScheduleOutput, ScheduleClientInterceptor } from './interceptors';
import { WorkflowService } from './types';
import { isServerErrorResponse, ServiceError } from './errors';
import {
  Backfill,
  CompiledScheduleUpdateOptions,
  ScheduleSummary,
  ScheduleDescription,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleUpdateOptions,
  ScheduleOptionsAction,
  ScheduleOptionsStartWorkflowAction,
} from './schedule-types';
import {
  compileScheduleOptions,
  compileUpdatedScheduleOptions,
  decodeOverlapPolicy,
  decodeScheduleAction,
  decodeScheduleRecentActions,
  decodeScheduleRunningActions,
  decodeScheduleSpec,
  decodeSearchAttributes,
  encodeOverlapPolicy,
  encodeScheduleAction,
  encodeSchedulePolicies,
  encodeScheduleSpec,
  encodeScheduleState,
} from './schedule-helpers';
import {
  BaseClient,
  BaseClientOptions,
  defaultBaseClientOptions,
  LoadedWithDefaults,
  WithDefaults,
} from './base-client';

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
  update<W extends Workflow = Workflow>(
    updateFn: (previous: ScheduleDescription) => ScheduleUpdateOptions<ScheduleOptionsStartWorkflowAction<W>>
  ): Promise<void>;

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
   * Run though the specified time period(s) and take Actions as if that time passed by right now, all at once.
   * The Overlap Policy can be overridden for the scope of the Backfill.
   */
  backfill(options: Backfill | Backfill[]): Promise<void>;

  /**
   * Pause the Schedule
   *
   * @param note A new {@link ScheduleDescription.note}. Defaults to `"Paused via TypeScript SDK"`
   */
  pause(note?: string): Promise<void>;

  /**
   * Unpause the Schedule
   *
   * @param note A new {@link ScheduleDescription.note}. Defaults to `"Unpaused via TypeScript SDK"
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
export interface ScheduleClientOptions extends BaseClientOptions {
  /**
   * Used to override and extend default Connection functionality
   *
   * Useful for injecting auth headers and tracing Workflow executions
   */
  interceptors?: ScheduleClientInterceptor[];
}

/** @experimental */
export type LoadedScheduleClientOptions = LoadedWithDefaults<ScheduleClientOptions>;

function defaultScheduleClientOptions(): WithDefaults<ScheduleClientOptions> {
  return {
    ...defaultBaseClientOptions(),
    interceptors: [],
  };
}

function assertRequiredScheduleOptions(opts: ScheduleOptions, action: 'CREATE'): void;
function assertRequiredScheduleOptions(opts: ScheduleUpdateOptions, action: 'UPDATE'): void;
function assertRequiredScheduleOptions(
  opts: ScheduleOptions | ScheduleUpdateOptions,
  action: 'CREATE' | 'UPDATE'
): void {
  const structureName = action === 'CREATE' ? 'ScheduleOptions' : 'ScheduleUpdateOptions';
  if (action === 'CREATE' && !(opts as ScheduleOptions).scheduleId) {
    throw new TypeError(`Missing ${structureName}.scheduleId`);
  }
  switch (opts.action.type) {
    case 'startWorkflow':
      if (!opts.action.taskQueue) {
        throw new TypeError(`Missing ${structureName}.action.taskQueue for 'startWorkflow' action`);
      }
      if (!opts.action.workflowId && action === 'UPDATE') {
        throw new TypeError(`Missing ${structureName}.action.workflowId for 'startWorkflow' action`);
      }
      if (!opts.action.workflowType) {
        throw new TypeError(`Missing ${structureName}.action.workflowType for 'startWorkflow' action`);
      }
  }
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
export class ScheduleClient extends BaseClient {
  public readonly options: LoadedScheduleClientOptions;

  constructor(options?: ScheduleClientOptions) {
    super(options);
    this.options = {
      ...defaultScheduleClientOptions(),
      ...filterNullAndUndefined(options ?? {}),
      loadedDataConverter: this.dataConverter,
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

  /**
   * Create a new Schedule.
   *
   * @throws {@link ScheduleAlreadyRunning} if there's a running (not deleted) Schedule with the given `id`
   * @returns a ScheduleHandle to the created Schedule
   */
  public async create<W extends Workflow = Workflow>(
    options: ScheduleOptions<ScheduleOptionsStartWorkflowAction<W>>
  ): Promise<ScheduleHandle>;
  public async create<A extends ScheduleOptionsAction>(options: ScheduleOptions<A>): Promise<ScheduleHandle> {
    await this._createSchedule(options);
    return this.getHandle(options.scheduleId);
  }

  /**
   * Create a new Schedule.
   */
  protected async _createSchedule(options: ScheduleOptions): Promise<void> {
    assertRequiredScheduleOptions(options, 'CREATE');
    const compiledOptions = compileScheduleOptions(options);

    const create = composeInterceptors(this.options.interceptors, 'create', this._createScheduleHandler.bind(this));
    await create({
      options: compiledOptions,
      headers: {},
    });
  }

  /**
   * Create a new Schedule.
   */
  protected async _createScheduleHandler(input: CreateScheduleInput): Promise<CreateScheduleOutput> {
    const { options: opts, headers } = input;
    const { identity } = this.options;
    const req: temporal.api.workflowservice.v1.ICreateScheduleRequest = {
      namespace: this.options.namespace,
      identity,
      requestId: uuid4(),
      scheduleId: opts.scheduleId,
      schedule: {
        spec: encodeScheduleSpec(opts.spec),
        action: await encodeScheduleAction(this.dataConverter, opts.action, headers),
        policies: encodeSchedulePolicies(opts.policies),
        state: encodeScheduleState(opts.state),
      },
      memo: opts.memo ? { fields: await encodeMapToPayloads(this.dataConverter, opts.memo) } : undefined,
      searchAttributes: opts.searchAttributes
        ? {
            indexedFields: mapToPayloads(searchAttributePayloadConverter, opts.searchAttributes),
          }
        : undefined,
      initialPatch: {
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
      return { conflictToken: res.conflictToken };
    } catch (err: any) {
      if (err.code === grpcStatus.ALREADY_EXISTS) {
        throw new ScheduleAlreadyRunning('Schedule already exists and is running', opts.scheduleId);
      }
      this.rethrowGrpcError(err, opts.scheduleId, 'Failed to create schedule');
    }
  }

  /**
   * Describe a Schedule.
   */
  protected async _describeSchedule(
    scheduleId: string
  ): Promise<temporal.api.workflowservice.v1.IDescribeScheduleResponse> {
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
   */
  protected async _updateSchedule(
    scheduleId: string,
    opts: CompiledScheduleUpdateOptions,
    header: Headers
  ): Promise<temporal.api.workflowservice.v1.IUpdateScheduleResponse> {
    try {
      return await this.workflowService.updateSchedule({
        namespace: this.options.namespace,
        scheduleId,
        schedule: {
          spec: encodeScheduleSpec(opts.spec),
          action: await encodeScheduleAction(this.dataConverter, opts.action, header),
          policies: encodeSchedulePolicies(opts.policies),
          state: encodeScheduleState(opts.state),
        },
        identity: this.options.identity,
        requestId: uuid4(),
      });
    } catch (err: any) {
      this.rethrowGrpcError(err, scheduleId, 'Failed to update schedule');
    }
  }

  /**
   * Patch a Schedule.
   */
  protected async _patchSchedule(
    scheduleId: string,
    patch: temporal.api.schedule.v1.ISchedulePatch
  ): Promise<temporal.api.workflowservice.v1.IPatchScheduleResponse> {
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
   */
  protected async _deleteSchedule(
    scheduleId: string
  ): Promise<temporal.api.workflowservice.v1.IDeleteScheduleResponse> {
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
      const response: temporal.api.workflowservice.v1.IListSchedulesResponse = await this.workflowService.listSchedules(
        {
          nextPageToken,
          namespace: this.options.namespace,
          maximumPageSize: options?.pageSize,
        }
      );

      for (const raw of response.schedules ?? []) {
        yield <ScheduleSummary>{
          scheduleId: raw.scheduleId,

          spec: decodeScheduleSpec(raw.info?.spec ?? {}),
          action: raw.info?.workflowType?.name && {
            type: 'startWorkflow',
            workflowType: raw.info.workflowType.name,
          },
          memo: await decodeMapFromPayloads(this.dataConverter, raw.memo?.fields),
          searchAttributes: decodeSearchAttributes(raw.searchAttributes),
          state: {
            paused: raw.info?.paused === true,
            note: raw.info?.notes ?? undefined,
          },
          info: {
            recentActions: decodeScheduleRecentActions(raw.info?.recentActions),
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
    return {
      client: this,
      scheduleId,

      async describe(): Promise<ScheduleDescription> {
        const raw = await this.client._describeSchedule(this.scheduleId);
        if (!raw.schedule?.spec || !raw.schedule.action)
          throw new Error('Received invalid Schedule description from server');
        return {
          scheduleId,
          spec: decodeScheduleSpec(raw.schedule.spec),
          action: await decodeScheduleAction(this.client.dataConverter, raw.schedule.action),
          memo: await decodeMapFromPayloads(this.client.dataConverter, raw.memo?.fields),
          searchAttributes: decodeSearchAttributes(raw.searchAttributes),
          policies: {
            overlap: decodeOverlapPolicy(raw.schedule.policies?.overlapPolicy),
            catchupWindow: optionalTsToMs(raw.schedule.policies?.catchupWindow) ?? 60_000,
            pauseOnFailure: raw.schedule.policies?.pauseOnFailure === true,
          },
          state: {
            paused: raw.schedule.state?.paused === true,
            note: raw.schedule.state?.notes ?? undefined,
            remainingActions: raw.schedule.state?.limitedActions
              ? raw.schedule.state?.remainingActions?.toNumber() || 0
              : undefined,
          },
          info: {
            recentActions: decodeScheduleRecentActions(raw.info?.recentActions),
            nextActionTimes: raw.info?.futureActionTimes?.map(tsToDate) ?? [],
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            createdAt: tsToDate(raw.info!.createTime!),
            lastUpdatedAt: optionalTsToDate(raw.info?.updateTime),
            runningActions: decodeScheduleRunningActions(raw.info?.runningWorkflows),
            numActionsMissedCatchupWindow: raw.info?.missedCatchupWindow?.toNumber() ?? 0,
            numActionsSkippedOverlap: raw.info?.overlapSkipped?.toNumber() ?? 0,
            numActionsTaken: raw.info?.actionCount?.toNumber() ?? 0,
          },
          raw,
        };
      },

      async update(updateFn): Promise<void> {
        const current = await this.describe();
        // Keep existing headers
        const currentHeader: Headers = current.raw.schedule?.action?.startWorkflow?.header?.fields ?? {};
        const updated = updateFn(current);
        assertRequiredScheduleOptions(updated, 'UPDATE');
        await this.client._updateSchedule(scheduleId, compileUpdatedScheduleOptions(updated), currentHeader);
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
