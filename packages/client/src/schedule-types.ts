import { checkExtends, Replace, RequireAtLeastOne } from '@temporalio/common/lib/type-helpers';
import { SearchAttributes, Workflow } from '@temporalio/common';
import type { temporal } from '@temporalio/proto';
import { WorkflowStartOptions } from './workflow-client';

export interface UpdateScheduleOptions {
  force: boolean;
}

export interface ListScheduleEntry {
  /**
   * Schedule Id
   *
   * We recommend using a meaningful business identifier.
   */
  scheduleId: string;

  /** When Actions are taken */
  spec: RequireAtLeastOne<ScheduleSpecDescription, 'calendars' | 'intervals'>;

  /**
   * Additional non-indexed information attached to the Schedule. The values can be anything that is
   * serializable by the {@link DataConverter}.
   */
  memo?: Record<string, any>;

  /**
   * Additional indexed information attached to the Schedule. More info:
   * https://docs.temporal.io/docs/typescript/search-attributes
   *
   * Values are always converted using {@link JsonPayloadConverter}, even when a custom Data Converter is provided.
   */
  searchAttributes: SearchAttributes;

  /**
   * Informative human-readable message with contextual notes, e.g. the reason
   * a Schedule is paused. The system may overwrite this message on certain
   * conditions, e.g. when pause-on-failure happens.
   */
  note?: string;

  /**
   * Whether Schedule is currently paused.
   *
   * @default false
   */
  paused: boolean;

  /**
   * Present if action is a {@link StartWorkflowAction}.
   */
  workflowType?: string;

  /**
   * Most recent 10 Actions started (including manual triggers).
   *
   * Sorted from older start time to newer.
   */
  recentActions: ScheduleAction[];

  /** Next 10 scheduled Action times */
  nextActionTimes: Date[];
}

/**
 * The current Schedule details. They may not match the Schedule as created because:
 * - some fields in the state are modified automatically
 * - the schedule may have been modified by {@link ScheduleHandle.update} or
 *   {@link ScheduleHandle.pause}/{@link ScheduleHandle.unpause}
 */
export type Schedule = ListScheduleEntry & {
  /**
   * Which Action to take
   */
  action: ScheduleActionOptions;

  /**
   * Controls what happens when an Action would be started by a Schedule at the same time that an older Action is still
   * running.
   *
   * @default {@link ScheduleOverlapPolicy.SKIP}
   */
  overlap: ScheduleOverlapPolicy;

  /**
   * The Temporal Server might be down or unavailable at the time when a Schedule should take an Action. When the Server
   * comes back up, `catchupWindow` controls which missed Actions should be taken at that point. The default is one
   * minute, which means that the Schedule attempts to take any Actions that wouldn't be more than one minute late. It
   * takes those Actions according to the {@link ScheduleOverlapPolicy}. An outage that lasts longer than the Catchup
   * Window could lead to missed Actions. (But you can always {@link ScheduleHandle.backfill}.)
   *
   * @default 1 minute
   * @format number of milliseconds
   */
  catchupWindow: number | undefined;

  /**
   * When an Action times out or reaches the end of its Retry Policy, {@link pause}.
   *
   * With {@link ScheduleOverlapPolicy.ALLOW_ALL}, this pause might not apply to the next Action, because the next Action
   * might have already started previous to the failed one finishing. Pausing applies only to Actions that are scheduled
   * to start after the failed one finishes.
   *
   * @default false
   */
  pauseOnFailure: boolean;

  /**
   * The Actions remaining in this Schedule. Once this number hits `0`, no further Actions are taken (unless {@link
   * ScheduleHandle.trigger} is called).
   *
   * @default undefined (unlimited)
   */
  remainingActions?: number;

  /** Number of Actions taken so far. */
  numActionsTaken: number;

  /** Number of times a scheduled Action was skipped due to missing the catchup window. */
  numActionsMissedCatchupWindow: number;

  /** Number of Actions skipped due to overlap. */
  numActionsSkippedOverlap: number;

  /**
   * Currently-running workflows started by this schedule. (There might be
   * more than one if the overlap policy allows overlaps.)
   */
  runningWorkflows: WorkflowExecutionWithFirstExecutionRunId[];

  createdAt: Date;
  lastUpdatedAt: Date | undefined;

  raw: temporal.api.workflowservice.v1.IDescribeScheduleResponse;
};

export type UpdatedSchedule<Action extends Workflow> = Pick<
  ScheduleOptions<Action>,
  'spec' | 'action' | 'overlap' | 'catchupWindow' | 'pauseOnFailure' | 'note' | 'paused'
>;

/**
 * Make all properties optional.
 *
 * If original Schedule is deleted, okay to use same `id`.
 */
export type ScheduleOptionsOverrides<Action extends Workflow> = Partial<ScheduleOptions<Action>>;

export interface WorkflowExecutionWithFirstExecutionRunId {
  workflowId: string;

  /**
   * The Run Id of the original execution that was started by the Schedule. If the Workflow retried, did
   * Continue-As-New, or was Reset, the following runs would have different Run Ids.
   */
  firstExecutionRunId: string;
}

export interface ScheduleAction {
  /** Time that the Action was scheduled for, including jitter. */
  scheduledAt: Date;

  /** Time that the Action was actually taken. */
  takenAt: Date;

  /** If action was {@link StartWorkflowAction}. */
  workflow?: WorkflowExecutionWithFirstExecutionRunId;
}

/**
 * Policy for overlapping Actions.
 */
export enum ScheduleOverlapPolicy {
  /**
   * Use server default (currently SKIP).
   *
   * TODO remove this field if this issue is implemented: https://github.com/temporalio/temporal/issues/3240
   */
  UNSPECIFIED = 0,

  /**
   * Don't start a new Action.
   */
  SKIP,

  /**
   * Start another Action as soon as the current Action completes, but only buffer one Action in this way. If another
   * Action is supposed to start, but one Action is running and one is already buffered, then only the buffered one will
   * be started after the running Action finishes.
   */
  BUFFER_ONE,

  /**
   * Allows an unlimited number of Actions to buffer. They are started sequentially.
   */
  BUFFER_ALL,

  /**
   * Cancels the running Action, and then starts the new Action once the cancelled one completes.
   */
  CANCEL_OTHER,

  /**
   * Terminate the running Action and start the new Action immediately.
   */
  TERMINATE_OTHER,

  /**
   * Allow any number of Actions to start immediately.
   *
   * This is the only policy under which multiple Actions can run concurrently.
   */
  ALLOW_ALL,
}

checkExtends<
  keyof typeof temporal.api.enums.v1.ScheduleOverlapPolicy,
  `SCHEDULE_OVERLAP_POLICY_${keyof typeof ScheduleOverlapPolicy}`
>();
checkExtends<
  `SCHEDULE_OVERLAP_POLICY_${keyof typeof ScheduleOverlapPolicy}`,
  keyof typeof temporal.api.enums.v1.ScheduleOverlapPolicy
>();

export interface Backfill {
  /** Time range to evaluate Schedule in. */
  start: Date;
  end: Date;

  /**
   * Override the Overlap Policy for this request.
   */
  overlap?: ScheduleOverlapPolicy;
}

/**
 * Example Ranges:
 *
 * ```
 * { start: 2 } ➡️ 2
 * { start: 2, end: 4 } ➡️ 2, 3, 4
 * { start: 2, end: 10, step: 3 } ➡️ 2, 5, 8
 * ```
 */
export type Range<Unit> = RangeStartOnly<Unit> | RangeStartEndSkip<Unit>;

interface RangeStartOnly<Unit> {
  /**
   * Start of range (inclusive)
   */
  start: Unit;

  /**
   * End of range (inclusive)
   *
   * @default `start`
   */
  end?: never;

  /**
   * The step to take between each value.
   *
   * @default 1
   */
  step?: never;
}

interface RangeStartEndSkip<Unit> extends Omit<RangeStartOnly<Unit>, 'end' | 'step'> {
  /**
   * End of range (inclusive)
   *
   * @default `start`
   */
  end: Unit;

  /**
   * The step to take between each value.
   *
   * @default 1
   */
  step?: number;
}

export type NumberSpec = number | Range<number> | (Range<number> | number)[] | '*';
export type NumberSpecDescription = Range<number>[];

const Months = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
] as const;
export type Month = typeof Months[number];
export type MonthSpec = Month | Range<Month> | (Range<Month> | Month)[] | '*';
export type MonthSpecDescription = Range<Month>[];

// FIXME-JWH: Consider use a hash lookup for name to number
export const monthNameToNumber = (month: Month): number | undefined => {
  const index = Months.indexOf(month);
  return index >= 0 ? index + 1 : undefined;
};
export const monthNumberToName = (month: number): Month => Months[month - 1];

const DaysOfWeek = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
export type Day = typeof DaysOfWeek[number];
export type DaySpec = Day | Range<Day> | (Range<Day> | Day)[] | '*';
export type DaySpecDescription = Range<Day>[];

// FIXME-JWH: Consider use a hash lookup for name to number
export const dayOfWeekNameToNumber = (day: Day): number | undefined => {
  const index = DaysOfWeek.indexOf(day);
  return index >= 0 ? index : undefined;
};
export const dayOfWeekNumberToName = (day: number): Day => DaysOfWeek[day];

/**
 * An event specification relative to the calendar, similar to a traditional cron specification.
 *
 * A second in time matches if all fields match. This includes `dayOfMonth` and `dayOfWeek`.
 */
export interface CalendarSpec {
  /**
   * Valid values: 0–59
   *
   * @default 0
   */
  second?: NumberSpec;

  /**
   * Valid values: 0–59
   *
   * @default 0
   */
  minute?: NumberSpec;

  /**
   * Valid values: 0–59
   *
   * @default 0
   */
  hour?: NumberSpec;

  /**
   * Valid values: 1–31
   *
   * @default '*'
   */
  dayOfMonth?: NumberSpec;

  /**
   * @default '*'
   */
  month?: MonthSpec;

  /**
   * Use full years, like `2030`
   *
   * @default '*'
   */
  year?: NumberSpec;

  /**
   * @default '*'
   */
  dayOfWeek?: DaySpec;

  /**
   * Description of the intention of this spec.
   */
  comment?: string;
}

/**
 * The version of {@link CalendarSpec} that you get back from {@link ScheduleHandle.describe} and
 * {@link ScheduleClient.list}
 */
export interface CalendarSpecDescription {
  /**
   * Valid values: 0–59
   *
   * If the default input is used, the default output will be `[{ start: 0, end: 0, step: 0 }]`.
   */
  second: NumberSpecDescription;

  /**
   * Valid values: 0–59
   *
   * If the default input is used, the default output will be `[{ start: 0, end: 0, step: 0 }]`.
   */
  minute: NumberSpecDescription;

  /**
   * Valid values: 0–23
   *
   * If the default input is used, the default output will be `[{ start: 0, end: 0, step: 0 }]`.
   */
  hour: NumberSpecDescription;

  /**
   * Valid values: 1–31
   *
   * If the default input is used, the default output will be `[{ start: 1, end: 31, step: 1 }]`.
   */
  dayOfMonth: NumberSpecDescription;
  // step will be 0/default over wire

  /**
   * If the default input is used, the default output will be `[{ start: 'JANUARY' , end: 'DECEMBER', step: 1 }]`.
   */
  month: MonthSpecDescription;
  // will get { start: 1, end: 12, step 0 } from server

  /**
   * Use full years, like `2030`
   *
   * If the default input it used, the default output will be `undefined` (meaning any year).
   */
  year: NumberSpecDescription;

  /**
   * If the default input it used, the default output will be `[{ start: 'SUNDAY', end: 'SATURDAY', step: 1 }]`.
   */
  dayOfWeek: DaySpecDescription;
  // will get { start: 0, end: 6, step 0 } from server

  /**
   * Description of the intention of this spec.
   */
  comment?: string;
}

/**
 * IntervalSpec matches times that can be expressed as:
 *
 * `Epoch + (n * every) + offset`
 *
 * where `n` is all integers ≥ 0.
 *
 * For example, an `every` of 1 hour with `offset` of zero would match every hour, on the hour. The same `every` but an `offset`
 * of 19 minutes would match every `xx:19:00`. An `every` of 28 days with `offset` zero would match `2022-02-17T00:00:00Z`
 * (among other times). The same `every` with `offset` of 3 days, 5 hours, and 23 minutes would match `2022-02-20T05:23:00Z`
 * instead.
 */
export interface IntervalSpec {
  /**
   * Value is rounded to the nearest second.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  every: number | string;

  /**
   * Value is rounded to the nearest second.
   *
   * @default 0
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  offset?: number | string;
}

/**
 * The version of {@link IntervalSpec} that you get back from {@link ScheduleHandle.describe}
 */
export interface IntervalSpecDescription {
  /**
   * Value is rounded to the nearest second.
   *
   * @format number of milliseconds
   */
  every: number;

  /**
   * Value is rounded to the nearest second.
   *
   * @default 0
   * @format number of milliseconds
   */
  offset?: number;
}

/**
 * A complete description of a set of absolute times (possibly infinite) that an Action should occur at.
 * The times are the union of `calendars`, `intervals`, and `cronExpressions`, minus the `skip` times. These times
 * never change, except that the definition of a time zone can change over time (most commonly, when daylight saving
 * time policy changes for an area). To create a totally self-contained `ScheduleSpec`, use UTC.
 */
export interface ScheduleSpec {
  /** Calendar-based specifications of times. */
  calendars?: CalendarSpec[];

  /** Interval-based specifications of times. */
  intervals?: IntervalSpec[];

  /**
   * [Cron expressions](https://crontab.guru/). This is provided for easy migration from legacy Cron Workflows. For new
   * use cases, we recommend using {@link calendars} or {@link intervals} for readability and maintainability.
   *
   * For example, `0 12 * * MON-WED,FRI` is every M/Tu/W/F at noon, and is equivalent to this {@link CalendarSpec}:
   *
   * ```ts
   * {
   *   hour: 12,
   *   dayOfWeek: [{
   *     start: 'MONDAY'
   *     end: 'WEDNESDAY'
   *   }, 'FRIDAY']
   * }
   * ```
   *
   * The string can have 5, 6, or 7 fields, separated by spaces, and they are interpreted in the
   * same way as a {@link CalendarSpec}.
   *
   * - 5 fields:         minute, hour, day_of_month, month, day_of_week
   * - 6 fields:         minute, hour, day_of_month, month, day_of_week, year
   * - 7 fields: second, minute, hour, day_of_month, month, day_of_week, year
   *
   * Notes:
   *
   * - If year is not given, it defaults to *.
   * - If second is not given, it defaults to 0.
   * - Shorthands @yearly, @monthly, @weekly, @daily, and @hourly are also
   * accepted instead of the 5-7 time fields.
   * - @every <interval>[/<phase>] is accepted and gets compiled into an
   * IntervalSpec instead. <interval> and <phase> should be a decimal integer
   * with a unit suffix s, m, h, or d.
   * - Optionally, the string can be preceded by CRON_TZ=<timezone name> or
   * TZ=<timezone name>, which will get copied to {@link timezone}. (In which case the {@link timezone} field should be left empty.)
   * - Optionally, "#" followed by a comment can appear at the end of the string.
   * - Note that the special case that some cron implementations have for
   * treating day_of_month and day_of_week as "or" instead of "and" when both
   * are set is not implemented.
   */
  cronExpressions?: string[];

  /**
   * Any matching times will be skipped.
   *
   * All aspects of the CalendarSpec—including seconds—must match a time for the time to be skipped.
   */
  skip?: CalendarSpec[];
  // TODO see if users want to be able to skip an IntervalSpec
  // https://github.com/temporalio/api/pull/230/files#r956434347

  /**
   * Any times before `startAt` will be skipped. Together, `startAt` and `endAt` make an inclusive interval.
   *
   * @default The beginning of time
   */
  startAt?: Date;

  /**
   * Any times after `endAt` will be skipped.
   *
   * @default The end of time
   */
  endAt?: Date;

  /**
   * All times will be incremented by a random value from 0 to this amount of jitter.
   *
   * @default 0
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  jitter?: number | string;

  /**
   * IANA timezone name, for example `US/Pacific`.
   *
   * https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
   *
   * The definition will be loaded by Temporal Server from the environment it runs in.
   *
   * Calendar spec matching is based on literal matching of the clock time
   * with no special handling of DST: if you write a calendar spec that fires
   * at 2:30am and specify a time zone that follows DST, that action will not
   * be triggered on the day that has no 2:30am. Similarly, an action that
   * fires at 1:30am will be triggered twice on the day that has two 1:30s.
   *
   * Also note that no actions are taken on leap-seconds (e.g. 23:59:60 UTC).
   *
   * @default UTC
   */
  timezone?: string;

  // Add to SDK if requested by users:
  //
  // bytes timezone_data = 11;
  //
  // Time zone to interpret all CalendarSpecs in.
  //
  // Time zones may be provided by name, corresponding to names in the IANA
  // time zone database (see https://www.iana.org/time-zones). The definition
  // will be loaded by the Temporal server from the environment it runs in.
  //
  // If your application requires more control over the time zone definition
  // used, it may pass in a complete definition in the form of a TZif file
  // from the time zone database. If present, this will be used instead of
  // loading anything from the environment. You are then responsible for
  // updating timezone_data when the definition changes.
}

/**
 * The version of {@link ScheduleSpec} that you get back from {@link ScheduleHandle.describe}
 */
export type ScheduleSpecDescription = Omit<
  ScheduleSpec,
  'calendars' | 'intervals' | 'cronExpressions' | 'skip' | 'jitter'
> & {
  /** Calendar-based specifications of times. */
  calendars?: CalendarSpecDescription[];

  /** Interval-based specifications of times. */
  intervals?: IntervalSpecDescription[];

  /** Any matching times will be skipped. */
  skip?: CalendarSpecDescription[];

  /**
   * All times will be incremented by a random value from 0 to this amount of jitter.
   *
   * @default 1 second
   * @format number of milliseconds
   */
  jitter?: number;
};

export type StartWorkflowAction<Action extends Workflow> = Omit<
  WorkflowStartOptions<Action>,
  'workflowIdReusePolicy' | 'cronSchedule' | 'followRuns'
> & {
  // This is most convenient for TS typing. Other SDKs may want to implement this differently, for example nesting:
  // action: {
  //   startWorkflow: {
  //     workflowId: 'wf-biz-id',
  //     ...
  //   }
  // }
  type: 'startWorkflow';

  workflowType: string | Action;
};

export type ScheduleActionType = Workflow;

/**
 * Currently, Temporal Server only supports {@link StartWorkflowAction}.
 */
export type ScheduleActionOptions<Action extends ScheduleActionType = ScheduleActionType> = StartWorkflowAction<Action>;
// in future:
// type SomethingElse = { fieldFoo: string, type: 'startFoo' }
// type ScheduleActionType = Workflow | SomethingElse
// type ExpectsSomethingElse<Action extends SomethingElse> = Action extends SomethingElse ? Action : number;
// type StartSomethingElseAction<Action extends SomethingElse> = ExpectsSomethingElse<Action>
// type ScheduleActionOptions<Action extends ScheduleActionType> =
//   StartWorkflowAction<Action> | StartSomethingElseAction<Action>

/**
 * Options for starting a Workflow
 */
export interface ScheduleOptions<Action extends ScheduleActionType> {
  /**
   * Schedule Id
   *
   * We recommend using a meaningful business identifier.
   */
  scheduleId: string;

  /** When Actions should be taken */
  spec: RequireAtLeastOne<ScheduleSpec, 'calendars' | 'intervals' | 'cronExpressions'>;

  /**
   * Which Action to take
   */
  action: ScheduleActionOptions<Action>;

  /**
   * Controls what happens when an Action would be started by a Schedule at the same time that an older Action is still
   * running. This can be changed after a Schedule has taken some Actions, and some changes might produce
   * unintuitive results. In general, the later policy overrides the earlier policy.
   *
   * @default {@link ScheduleOverlapPolicy.SKIP}
   */
  overlap?: ScheduleOverlapPolicy;

  /**
   * The Temporal Server might be down or unavailable at the time when a Schedule should take an Action. When the Server
   * comes back up, `catchupWindow` controls which missed Actions should be taken at that point. The default is one
   * minute, which means that the Schedule attempts to take any Actions that wouldn't be more than one minute late. It
   * takes those Actions according to the {@link ScheduleOverlapPolicy}. An outage that lasts longer than the Catchup
   * Window could lead to missed Actions. (But you can always {@link ScheduleHandle.backfill}.)
   *
   * @default 1 minute
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  catchupWindow?: number | string;

  /**
   * When an Action times out or reaches the end of its Retry Policy, {@link pause}.
   *
   * With {@link ScheduleOverlapPolicy.ALLOW_ALL}, this pause might not apply to the next Action, because the next Action
   * might have already started previous to the failed one finishing. Pausing applies only to Actions that are scheduled
   * to start after the failed one finishes.
   *
   * @default false
   */
  pauseOnFailure?: boolean;

  /**
   * Informative human-readable message with contextual notes, e.g. the reason
   * a Schedule is paused. The system may overwrite this message on certain
   * conditions, e.g. when pause-on-failure happens.
   */
  note?: string;

  /**
   * Start in paused state.
   *
   * @default false
   */
  paused?: boolean;

  /**
   * Limit the number of Actions to take.
   *
   * This number is decremented after each Action is taken, and Actions are not
   * taken when the number is `0` (unless {@link ScheduleHandle.trigger} is called).
   *
   * @default unlimited
   */
  remainingActions?: number;

  /**
   * Trigger one Action immediately.
   *
   * @default false
   */
  triggerImmediately?: boolean;

  /**
   * Runs though the specified time periods and takes Actions as if that time passed by right now, all at once. The
   * overlap policy can be overridden for the scope of the backfill.
   */
  backfill?: Backfill[];

  /**
   * Additional non-indexed information attached to the Schedule. The values can be anything that is
   * serializable by the {@link DataConverter}.
   */
  memo?: Record<string, any>;

  /**
   * Additional indexed information attached to the Schedule. More info:
   * https://docs.temporal.io/docs/typescript/search-attributes
   *
   * Values are always converted using {@link JsonPayloadConverter}, even when a custom Data Converter is provided.
   */
  searchAttributes?: SearchAttributes;
}

export type CompiledScheduleOptions = Replace<
  ScheduleOptions<Workflow>,
  {
    action: Replace<
      ScheduleActionOptions<Workflow>,
      {
        workflowType: string;
        args: unknown[];
      }
    >;
  }
>;

export function compileScheduleOptions<Action extends Workflow>(
  options: ScheduleOptions<Action>
): CompiledScheduleOptions {
  const workflowTypeOrFunc = options.action.workflowType;
  const workflowType = typeof workflowTypeOrFunc === 'string' ? workflowTypeOrFunc : workflowTypeOrFunc.name;
  return {
    ...options,
    action: {
      ...options.action,
      workflowType,
      args: options.action.args ?? [],
    },
  };
}

export type CompiledUpdatedSchedule = Replace<
  UpdatedSchedule<Workflow>,
  {
    action: Replace<
      ScheduleActionOptions<Workflow>,
      {
        workflowType: string;
        args: unknown[];
      }
    >;
  }
>;

export function compileUpdatedScheduleOptions<Action extends Workflow>(
  options: UpdatedSchedule<Action>
): CompiledUpdatedSchedule {
  const workflowTypeOrFunc = options.action.workflowType;
  const workflowType = typeof workflowTypeOrFunc === 'string' ? workflowTypeOrFunc : workflowTypeOrFunc.name;
  return {
    ...options,
    action: {
      ...options.action,
      workflowType,
      args: options.action.args ?? [],
    },
  };
}

export interface ListScheduleOptions {
  /**
   * How many results to fetch from the Server at a time.
   * @default 1000
   */
  pageSize?: number;
}
