import { checkExtends, Replace } from '@temporalio/common/lib/type-helpers';
import { Duration, SearchAttributes, Workflow, TypedSearchAttributes, SearchAttributePair } from '@temporalio/common';
import { makeProtoEnumConverters } from '@temporalio/common/lib/internal-workflow';
import type { temporal } from '@temporalio/proto';
import { WorkflowStartOptions } from './workflow-options';

/**
 * The specification of a Schedule to be created, as expected by {@link ScheduleClient.create}.
 */
export interface ScheduleOptions<A extends ScheduleOptionsAction = ScheduleOptionsAction> {
  /**
   * Schedule Id
   *
   * We recommend using a meaningful business identifier.
   */
  scheduleId: string;

  /**
   * When Actions should be taken
   */
  spec: ScheduleSpec;

  /**
   * Which Action to take
   */
  action: A;

  policies?: {
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
     * @default 1 year
     * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
     */
    catchupWindow?: Duration;

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
  };

  /**
   * Additional non-indexed information attached to the Schedule. The values can be anything that is
   * serializable by the {@link DataConverter}.
   */
  memo?: Record<string, unknown>;

  /**
   * Additional indexed information attached to the Schedule. More info:
   * https://docs.temporal.io/docs/typescript/search-attributes
   *
   * Values are always converted using {@link JsonPayloadConverter}, even when a custom Data Converter is provided.
   *
   * @deprecated Use {@link typedSearchAttributes} instead.
   */
  searchAttributes?: SearchAttributes; // eslint-disable-line deprecation/deprecation

  /**
   * Additional indexed information attached to the Schedule. More info:
   * https://docs.temporal.io/docs/typescript/search-attributes
   *
   * Values are always converted using {@link JsonPayloadConverter}, even when a custom Data Converter is provided.
   *
   * If both {@link searchAttributes} and {@link typedSearchAttributes} are provided, conflicting keys will be overwritten
   * by {@link typedSearchAttributes}.
   */
  typedSearchAttributes?: SearchAttributePair[] | TypedSearchAttributes;

  /**
   * The initial state of the schedule, right after creation or update.
   */
  state?: {
    /**
     * Start in paused state.
     *
     * @default false
     */
    paused?: boolean;

    /**
     * Informative human-readable message with contextual notes, e.g. the reason
     * a Schedule is paused. The system may overwrite this message on certain
     * conditions, e.g. when pause-on-failure happens.
     */
    note?: string;

    /**
     * Limit the number of Actions to take.
     *
     * This number is decremented after each Action is taken, and Actions are not
     * taken when the number is `0` (unless {@link ScheduleHandle.trigger} is called).
     *
     * If `undefined`, then no such limit applies.
     *
     * @default undefined, which allows for unlimited exections
     */
    remainingActions?: number;

    /**
     * Trigger one Action immediately on create.
     *
     * @default false
     */
    triggerImmediately?: boolean;

    /**
     * Runs though the specified time periods and takes Actions as if that time passed by right now, all at once. The
     * overlap policy can be overridden for the scope of the backfill.
     */
    backfill?: Backfill[];
  };
}

export type CompiledScheduleOptions = Replace<
  ScheduleOptions,
  {
    action: CompiledScheduleAction;
  }
>;

/**
 * The specification of an updated Schedule, as expected by {@link ScheduleHandle.update}.
 */
export type ScheduleUpdateOptions<A extends ScheduleOptionsAction = ScheduleOptionsAction> = Replace<
  Omit<ScheduleOptions, 'scheduleId' | 'memo'>,
  {
    action: A;
    state: Omit<ScheduleOptions['state'], 'triggerImmediately' | 'backfill'>;
  }
>;

export type CompiledScheduleUpdateOptions = Replace<
  ScheduleUpdateOptions,
  {
    action: CompiledScheduleAction;
  }
>;

/**
 * A summary description of an existing Schedule, as returned by {@link ScheduleClient.list}.
 *
 * Note that schedule listing is eventual consistent; some returned properties may therefore
 * be undefined or incorrect for some time after creating or modifying a schedule.
 */
export interface ScheduleSummary {
  /**
   * The Schedule Id. We recommend using a meaningful business identifier.
   */
  scheduleId: string;

  /**
   * When will Actions be taken.
   */
  spec?: ScheduleSpecDescription;

  /**
   * The Action that will be taken.
   */
  action?: ScheduleSummaryAction;

  /**
   * Additional non-indexed information attached to the Schedule.
   * The values can be anything that is serializable by the {@link DataConverter}.
   */
  memo?: Record<string, unknown>;

  /**
   * Additional indexed information attached to the Schedule. More info:
   * https://docs.temporal.io/docs/typescript/search-attributes
   *
   * Values are always converted using {@link JsonPayloadConverter}, even when a custom Data Converter is provided.
   *
   * @deprecated Use {@link typedSearchAttributes} instead.
   */
  searchAttributes?: SearchAttributes; // eslint-disable-line deprecation/deprecation

  /**
   * Additional indexed information attached to the Schedule. More info:
   * https://docs.temporal.io/docs/typescript/search-attributes
   *
   * Values are always converted using {@link JsonPayloadConverter}, even when a custom Data Converter is provided.
   */
  typedSearchAttributes?: TypedSearchAttributes;

  state: {
    /**
     * Whether Schedule is currently paused.
     */
    paused: boolean;

    /**
     * Informative human-readable message with contextual notes, e.g. the reason a Schedule is paused.
     * The system may overwrite this message on certain conditions, e.g. when pause-on-failure happens.
     */
    note?: string;
  };

  info: {
    /**
     * Most recent actions started (including manual triggers), sorted from older start time to newer.
     */
    recentActions: ScheduleExecutionResult[];

    /**
     * Next upcoming scheduled times of this Schedule
     */
    nextActionTimes: Date[];
  };
}

export interface ScheduleExecutionResult {
  /** Time that the Action was scheduled for, including jitter */
  scheduledAt: Date;

  /** Time that the Action was actually taken */
  takenAt: Date;

  /** The Action that was taken */
  action: ScheduleExecutionActionResult;
}

export type ScheduleExecutionActionResult = ScheduleExecutionStartWorkflowActionResult;

export interface ScheduleExecutionStartWorkflowActionResult {
  type: 'startWorkflow';
  workflow: {
    workflowId: string;

    /**
     * The Run Id of the original execution that was started by the Schedule. If the Workflow retried, did
     * Continue-As-New, or was Reset, the following runs would have different Run Ids.
     */
    firstExecutionRunId: string;
  };
}

/**
 * A detailed description of an exisiting Schedule, as returned by {@link ScheduleHandle.describe}.
 */
export type ScheduleDescription = {
  /**
   * The Schedule Id. We recommend using a meaningful business identifier.
   */
  scheduleId: string;

  /**
   * When will Actions be taken.
   */
  spec: ScheduleSpecDescription;

  /**
   * The Action that will be taken.
   */
  action: ScheduleDescriptionAction;

  policies: {
    /**
     * Controls what happens when an Action would be started by a Schedule at the same time that an older Action is still
     * running.
     */
    overlap: ScheduleOverlapPolicy;

    /**
     * The Temporal Server might be down or unavailable at the time when a Schedule should take an Action.
     * When the Server comes back up, `catchupWindow` controls which missed Actions should be taken at that point.
     * It takes those Actions according to the {@link ScheduleOverlapPolicy}. An outage that lasts longer than the
     * Catchup Window could lead to missed Actions. (But you can always {@link ScheduleHandle.backfill}.)
     *
     * Unit is miliseconds.
     */
    catchupWindow: number;

    /**
     * When an Action times out or reaches the end of its Retry Policy, {@link pause}.
     *
     * With {@link ScheduleOverlapPolicy.ALLOW_ALL}, this pause might not apply to the next Action, because the next Action
     * might have already started previous to the failed one finishing. Pausing applies only to Actions that are scheduled
     * to start after the failed one finishes.
     */
    pauseOnFailure: boolean;
  };

  /**
   * Additional non-indexed information attached to the Schedule.
   * The values can be anything that is serializable by the {@link DataConverter}.
   */
  memo?: Record<string, unknown>;

  /**
   * Additional indexed information attached to the Schedule. More info:
   * https://docs.temporal.io/docs/typescript/search-attributes
   *
   * Values are always converted using {@link JsonPayloadConverter}, even when a custom Data Converter is provided.
   *
   * @deprecated Use {@link typedSearchAttributes} instead.
   */
  searchAttributes: SearchAttributes; // eslint-disable-line deprecation/deprecation

  /**
   * Additional indexed information attached to the Schedule. More info:
   * https://docs.temporal.io/docs/typescript/search-attributes
   *
   * Values are always converted using {@link JsonPayloadConverter}, even when a custom Data Converter is provided.
   */
  typedSearchAttributes: TypedSearchAttributes;

  state: {
    /**
     * Whether Schedule is currently paused.
     */
    paused: boolean;

    /**
     * Informative human-readable message with contextual notes, e.g. the reason a Schedule is paused.
     * The system may overwrite this message on certain conditions, e.g. when pause-on-failure happens.
     */
    note?: string;

    /**
     * The Actions remaining in this Schedule.
     * Once this number hits `0`, no further Actions are taken (unless {@link ScheduleHandle.trigger} is called).
     *
     * If `undefined`, then no such limit applies.
     */
    remainingActions?: number;
  };

  info: {
    /**
     * Most recent actions started (including manual triggers), sorted from older start time to newer.
     */
    recentActions: ScheduleExecutionResult[];

    /**
     * Next upcoming scheduled times of this Schedule
     */
    nextActionTimes: Date[];

    /**
     * Number of Actions taken so far.
     */
    numActionsTaken: number;

    /**
     * Number of times a scheduled Action was skipped due to missing the catchup window.
     */
    numActionsMissedCatchupWindow: number;

    /**
     * Number of Actions skipped due to overlap.
     */
    numActionsSkippedOverlap: number;

    createdAt: Date;
    lastUpdatedAt: Date | undefined;

    /**
     * Currently-running workflows started by this schedule. (There might be
     * more than one if the overlap policy allows overlaps.)
     */
    runningActions: ScheduleExecutionActionResult[];
  };

  /** @internal */
  raw: temporal.api.workflowservice.v1.IDescribeScheduleResponse;
};

// Invariant: ScheduleDescription contains at least the same fields as ScheduleSummary
checkExtends<ScheduleSummary, ScheduleDescription>();

// Invariant: An existing ScheduleDescription can be used as template to create a new Schedule
checkExtends<ScheduleOptions, ScheduleDescription>();

// Invariant: An existing ScheduleDescription can be used as template to update that Schedule
checkExtends<ScheduleUpdateOptions, ScheduleDescription>();

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
   * - Shorthands `@yearly`, `@monthly`, `@weekly`, `@daily`, and `@hourly` are also
   * accepted instead of the 5-7 time fields.
   * - `@every interval[/<phase>]` is accepted and gets compiled into an
   * IntervalSpec instead. `<interval>` and `<phase>` should be a decimal integer
   * with a unit suffix s, m, h, or d.
   * - Optionally, the string can be preceded by `CRON_TZ=<timezone name>` or
   * `TZ=<timezone name>`, which will get copied to {@link timezone}.
   * (In which case the {@link timezone} field should be left empty.)
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
  jitter?: Duration;

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
}

/**
 * The version of {@link ScheduleSpec} that you get back from {@link ScheduleHandle.describe} and {@link ScheduleClient.list}
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

// Invariant: An existing ScheduleSpec can be used as is to create or update a Schedule
checkExtends<ScheduleSpec, ScheduleSpecDescription>();

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
  second?: LooseRange<number> | LooseRange<number>[] | '*';

  /**
   * Valid values: 0–59
   *
   * @default 0
   */
  minute?: LooseRange<number> | LooseRange<number>[] | '*';

  /**
   * Valid values: 0–23
   *
   * @default 0
   */
  hour?: LooseRange<number> | LooseRange<number>[] | '*';

  /**
   * Valid values: 1–31
   *
   * @default '*'
   */
  dayOfMonth?: LooseRange<number> | LooseRange<number>[] | '*';

  /**
   * @default '*'
   */
  month?: LooseRange<Month> | LooseRange<Month>[] | '*';

  /**
   * Use full years, like `2030`
   *
   * @default '*'
   */
  year?: LooseRange<number> | LooseRange<number>[] | '*';

  /**
   * @default '*'
   */
  dayOfWeek?: LooseRange<DayOfWeek> | LooseRange<DayOfWeek>[] | '*';

  /**
   * Description of the intention of this spec.
   */
  comment?: string;
}

/**
 * An event specification relative to the calendar, similar to a traditional cron specification.
 *
 * A second in time matches if all fields match. This includes `dayOfMonth` and `dayOfWeek`.
 */
export interface CalendarSpecDescription {
  /**
   * Valid values: 0–59
   *
   * @default Match only when second is 0 (ie. `[{ start: 0, end: 0, step: 0 }]`)
   */
  second: Range<number>[];

  /**
   * Valid values: 0–59
   *
   * @default Match only when minute is 0 (ie. `[{ start: 0, end: 0, step: 0 }]`)
   */
  minute: Range<number>[];

  /**
   * Valid values: 0–23
   *
   * @default Match only when hour is 0 (ie. `[{ start: 0, end: 0, step: 0 }]`)
   */
  hour: Range<number>[];

  /**
   * Valid values: 1–31
   *
   * @default Match on any day (ie. `[{ start: 1, end: 31, step: 1 }]`)
   */
  dayOfMonth: Range<number>[];

  /**
   * Valid values are 'JANUARY' to 'DECEMBER'.
   *
   * @default Match on any month (ie. `[{ start: 'JANUARY', end: 'DECEMBER', step: 1 }]`)
   */
  month: Range<Month>[];

  /**
   * Use full years, like `2030`
   *
   * @default Match on any year
   */
  year: Range<number>[];

  /**
   * Valid values are 'SUNDAY' to 'SATURDAY'.
   *
   * @default Match on any day of the week (ie. `[{ start: 'SUNDAY', end: 'SATURDAY', step: 1 }]`)
   */
  dayOfWeek: Range<DayOfWeek>[];

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
  every: Duration;

  /**
   * Value is rounded to the nearest second.
   *
   * @default 0
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  offset?: Duration;
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
 *
 * This is the version of {@link IntervalSpec} that you get back from {@link ScheduleHandle.describe} and {@link ScheduleClient.list}
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
   * @format number of milliseconds
   */
  offset: number;
}

/**
 * Range represents a set of values, used to match fields of a calendar. If end < start, then end is
 * interpreted as equal to start. Similarly, if step is less than 1, then step is interpreted as 1.
 */
export interface Range<Unit> {
  /**
   * Start of range (inclusive)
   */
  start: Unit;

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
  step: number;
}

/**
 * A {@link Range} definition, with support for loose syntax.
 *
 * For example:
 * ```
 * 3 ➡️ 3
 * { start: 2 } ➡️ 2
 * { start: 2, end: 4 } ➡️ 2, 3, 4
 * { start: 2, end: 10, step: 3 } ➡️ 2, 5, 8
 * ```
 */
export type LooseRange<Unit> =
  | Range<Unit>
  | { start: Range<Unit>['start']; end?: Range<Unit>['end']; step?: never }
  | Unit;

export const MONTHS = [
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

export type Month = (typeof MONTHS)[number];

export const DAYS_OF_WEEK = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export type ScheduleOptionsAction = ScheduleOptionsStartWorkflowAction<Workflow>;

export type ScheduleOptionsStartWorkflowAction<W extends Workflow> = {
  type: 'startWorkflow';
  workflowType: string | W;
} & Pick<
  WorkflowStartOptions<W>,
  | 'taskQueue'
  | 'args'
  | 'memo'
  | 'searchAttributes'
  | 'typedSearchAttributes'
  | 'retry'
  | 'workflowExecutionTimeout'
  | 'workflowRunTimeout'
  | 'workflowTaskTimeout'
  | 'staticDetails'
  | 'staticSummary'
> & {
    /**
     * Workflow id to use when starting. Assign a meaningful business id.
     * This ID can be used to ensure starting Workflows is idempotent.
     *
     * @default `${scheduleId}-workflow`
     */
    workflowId?: string;
  };

export type ScheduleSummaryAction = ScheduleSummaryStartWorkflowAction;

export interface ScheduleSummaryStartWorkflowAction {
  type: 'startWorkflow';
  workflowType: string;
}

export type ScheduleDescriptionAction = ScheduleDescriptionStartWorkflowAction;

export type ScheduleDescriptionStartWorkflowAction = ScheduleSummaryStartWorkflowAction &
  Pick<
    WorkflowStartOptions<Workflow>,
    | 'taskQueue'
    | 'workflowId'
    | 'args'
    | 'memo'
    | 'searchAttributes'
    | 'typedSearchAttributes'
    | 'retry'
    | 'workflowExecutionTimeout'
    | 'workflowRunTimeout'
    | 'workflowTaskTimeout'
    | 'staticSummary'
    | 'staticDetails'
    | 'priority'
  >;

// Invariant: an existing ScheduleDescriptionAction can be used as is to create or update a schedule
checkExtends<ScheduleOptionsAction, ScheduleDescriptionAction>();

export type CompiledScheduleAction = Replace<
  ScheduleDescriptionAction,
  {
    workflowType: string;
    args: unknown[];
  }
>;

/**
 * Policy for overlapping Actions.
 */
export const ScheduleOverlapPolicy = {
  /**
   * Don't start a new Action.
   * @default
   */
  SKIP: 'SKIP',

  /**
   * Start another Action as soon as the current Action completes, but only buffer one Action in this way. If another
   * Action is supposed to start, but one Action is running and one is already buffered, then only the buffered one will
   * be started after the running Action finishes.
   */
  BUFFER_ONE: 'BUFFER_ONE',

  /**
   * Allows an unlimited number of Actions to buffer. They are started sequentially.
   */
  BUFFER_ALL: 'BUFFER_ALL',

  /**
   * Cancels the running Action, and then starts the new Action once the cancelled one completes.
   */
  CANCEL_OTHER: 'CANCEL_OTHER',

  /**
   * Terminate the running Action and start the new Action immediately.
   */
  TERMINATE_OTHER: 'TERMINATE_OTHER',

  /**
   * Allow any number of Actions to start immediately.
   *
   * This is the only policy under which multiple Actions can run concurrently.
   */
  ALLOW_ALL: 'ALLOW_ALL',

  /**
   * Use server default (currently SKIP).
   *
   * @deprecated Either leave property `undefined`, or use {@link SKIP} instead.
   */
  UNSPECIFIED: undefined, // eslint-disable-line deprecation/deprecation
} as const;
export type ScheduleOverlapPolicy = (typeof ScheduleOverlapPolicy)[keyof typeof ScheduleOverlapPolicy];

export const [encodeScheduleOverlapPolicy, decodeScheduleOverlapPolicy] = makeProtoEnumConverters<
  temporal.api.enums.v1.ScheduleOverlapPolicy,
  typeof temporal.api.enums.v1.ScheduleOverlapPolicy,
  keyof typeof temporal.api.enums.v1.ScheduleOverlapPolicy,
  typeof ScheduleOverlapPolicy,
  'SCHEDULE_OVERLAP_POLICY_'
>(
  {
    [ScheduleOverlapPolicy.SKIP]: 1,
    [ScheduleOverlapPolicy.BUFFER_ONE]: 2,
    [ScheduleOverlapPolicy.BUFFER_ALL]: 3,
    [ScheduleOverlapPolicy.CANCEL_OTHER]: 4,
    [ScheduleOverlapPolicy.TERMINATE_OTHER]: 5,
    [ScheduleOverlapPolicy.ALLOW_ALL]: 6,
    UNSPECIFIED: 0,
  } as const,
  'SCHEDULE_OVERLAP_POLICY_'
);

export interface Backfill {
  /**
   * Start of the time range to evaluate Schedule in.
   */
  start: Date;

  /**
   * End of the time range to evaluate Schedule in.
   */
  end: Date;

  /**
   * Override the Overlap Policy for this request.
   *
   * @default SKIP
   */
  overlap?: ScheduleOverlapPolicy;
}
