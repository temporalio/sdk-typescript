import Long from 'long'; // eslint-disable-line import/no-named-as-default
import {
  compileRetryPolicy,
  decompileRetryPolicy,
  extractWorkflowType,
  LoadedDataConverter,
  mapFromPayloads,
  mapToPayloads,
  searchAttributePayloadConverter,
  SearchAttributes,
} from '@temporalio/common';
import { Headers } from '@temporalio/common/lib/interceptors';
import {
  decodeArrayFromPayloads,
  decodeMapFromPayloads,
  encodeMapToPayloads,
  encodeToPayloads,
} from '@temporalio/common/lib/internal-non-workflow';
import { temporal } from '@temporalio/proto';
import {
  msOptionalToTs,
  msToTs,
  optionalDateToTs,
  optionalTsToDate,
  optionalTsToMs,
  requiredTsToDate,
} from '@temporalio/common/lib/time';
import {
  CalendarSpec,
  CalendarSpecDescription,
  CompiledScheduleOptions,
  CompiledScheduleUpdateOptions,
  Range,
  ScheduleOptions,
  ScheduleUpdateOptions,
  DayOfWeek,
  DAYS_OF_WEEK,
  Month,
  MONTHS,
  LooseRange,
  ScheduleSpec,
  CompiledScheduleAction,
  ScheduleSpecDescription,
  IntervalSpecDescription,
  ScheduleDescriptionAction,
  ScheduleExecutionActionResult,
  ScheduleExecutionResult,
  ScheduleExecutionStartWorkflowActionResult,
  encodeScheduleOverlapPolicy,
} from './schedule-types';

const [encodeSecond, decodeSecond] = makeCalendarSpecFieldCoders(
  'second',
  (x: number) => (typeof x === 'number' && x >= 0 && x <= 59 ? x : undefined),
  (x: number) => x,
  [{ start: 0, end: 0, step: 0 }], // default to 0
  [{ start: 0, end: 59, step: 1 }]
);

const [encodeMinute, decodeMinue] = makeCalendarSpecFieldCoders(
  'minute',
  (x: number) => (typeof x === 'number' && x >= 0 && x <= 59 ? x : undefined),
  (x: number) => x,
  [{ start: 0, end: 0, step: 0 }], // default to 0
  [{ start: 0, end: 59, step: 1 }]
);

const [encodeHour, decodeHour] = makeCalendarSpecFieldCoders(
  'hour',
  (x: number) => (typeof x === 'number' && x >= 0 && x <= 23 ? x : undefined),
  (x: number) => x,
  [{ start: 0, end: 0, step: 0 }], // default to 0
  [{ start: 0, end: 23, step: 1 }]
);

const [encodeDayOfMonth, decodeDayOfMonth] = makeCalendarSpecFieldCoders(
  'dayOfMonth',
  (x: number) => (typeof x === 'number' && x >= 0 && x <= 31 ? x : undefined),
  (x: number) => x,
  [{ start: 1, end: 31, step: 1 }], // default to *
  [{ start: 1, end: 31, step: 1 }]
);

const [encodeMonth, decodeMonth] = makeCalendarSpecFieldCoders(
  'month',
  function monthNameToNumber(month: Month): number | undefined {
    const index = MONTHS.indexOf(month);
    return index >= 0 ? index + 1 : undefined;
  },
  (month: number) => MONTHS[month - 1],
  [{ start: 1, end: 12, step: 1 }], // default to *
  [{ start: 1, end: 12, step: 1 }]
);

const [encodeYear, decodeYear] = makeCalendarSpecFieldCoders(
  'year',
  (x: number) => (typeof x === 'number' ? x : undefined),
  (x: number) => x,
  [], // default to *
  [] // special case: * for years is encoded as no range at all
);

const [encodeDayOfWeek, decodeDayOfWeek] = makeCalendarSpecFieldCoders(
  'dayOfWeek',
  function dayOfWeekNameToNumber(day: DayOfWeek): number | undefined {
    const index = DAYS_OF_WEEK.indexOf(day);
    return index >= 0 ? index : undefined;
  },
  (day: number) => DAYS_OF_WEEK[day],
  [{ start: 0, end: 6, step: 1 }], // default to *
  [{ start: 0, end: 6, step: 1 }]
);

function makeCalendarSpecFieldCoders<Unit>(
  fieldName: string,
  encodeValueFn: (x: Unit) => number | undefined,
  decodeValueFn: (x: number) => Unit,
  defaultValue: temporal.api.schedule.v1.IRange[],
  matchAllValue: temporal.api.schedule.v1.IRange[]
) {
  function encoder(
    input: LooseRange<Unit> | LooseRange<Unit>[] | '*' | undefined
  ): temporal.api.schedule.v1.IRange[] | undefined {
    if (input === undefined) return defaultValue;
    if (input === '*') return matchAllValue;

    return (Array.isArray(input) ? input : [input]).map((item) => {
      if (typeof item === 'object' && (item as Range<Unit>).start !== undefined) {
        const range = item as Range<Unit>;
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
        const value = encodeValueFn(item as Unit);
        if (value !== undefined) return { start: value, end: value, step: 1 };
      }
      throw new TypeError(`Invalid CalendarSpec component for field ${fieldName}: '${item}' of type '${typeof item}'`);
    });
  }

  function decoder(input: temporal.api.schedule.v1.IRange[] | undefined | null): Range<Unit>[] {
    if (!input) return [];
    return (input as temporal.api.schedule.v1.Range[]).map((pb): Range<Unit> => {
      const start = decodeValueFn(pb.start);
      const end = pb.end > pb.start ? decodeValueFn(pb.end) ?? start : start;
      const step = pb.step > 0 ? pb.step : 1;
      return { start, end, step };
    });
  }

  return [encoder, decoder] as const;
}

export function encodeOptionalStructuredCalendarSpecs(
  input: CalendarSpec[] | null | undefined
): temporal.api.schedule.v1.IStructuredCalendarSpec[] | undefined {
  if (!input) return undefined;
  return input.map((spec) => ({
    second: encodeSecond(spec.second),
    minute: encodeMinute(spec.minute),
    hour: encodeHour(spec.hour),
    dayOfMonth: encodeDayOfMonth(spec.dayOfMonth),
    month: encodeMonth(spec.month),
    year: encodeYear(spec.year),
    dayOfWeek: encodeDayOfWeek(spec.dayOfWeek),
    comment: spec.comment,
  }));
}

export function decodeOptionalStructuredCalendarSpecs(
  input: temporal.api.schedule.v1.IStructuredCalendarSpec[] | null | undefined
): CalendarSpecDescription[] {
  if (!input) return [];

  return (input as temporal.api.schedule.v1.StructuredCalendarSpec[]).map(
    (pb): CalendarSpecDescription => ({
      second: decodeSecond(pb.second),
      minute: decodeMinue(pb.minute),
      hour: decodeHour(pb.hour),
      dayOfMonth: decodeDayOfMonth(pb.dayOfMonth),
      month: decodeMonth(pb.month),
      year: decodeYear(pb.year),
      dayOfWeek: decodeDayOfWeek(pb.dayOfWeek),
      comment: pb.comment,
    })
  );
}

export function compileScheduleOptions(options: ScheduleOptions): CompiledScheduleOptions {
  const workflowTypeOrFunc = options.action.workflowType;
  const workflowType = extractWorkflowType(workflowTypeOrFunc);
  return {
    ...options,
    action: {
      ...options.action,
      workflowId: options.action.workflowId ?? `${options.scheduleId}-workflow`,
      workflowType,
      args: (options.action.args ?? []) as unknown[],
    },
  };
}

export function compileUpdatedScheduleOptions(
  scheduleId: string,
  options: ScheduleUpdateOptions
): CompiledScheduleUpdateOptions {
  const workflowTypeOrFunc = options.action.workflowType;
  const workflowType = extractWorkflowType(workflowTypeOrFunc);
  return {
    ...options,
    action: {
      ...options.action,
      workflowId: options.action.workflowId ?? `${scheduleId}-workflow`,
      workflowType,
      args: (options.action.args ?? []) as unknown[],
    },
  };
}

export function encodeScheduleSpec(spec: ScheduleSpec): temporal.api.schedule.v1.IScheduleSpec {
  return {
    structuredCalendar: encodeOptionalStructuredCalendarSpecs(spec.calendars),
    interval: spec.intervals?.map((interval) => ({
      interval: msToTs(interval.every),
      phase: msOptionalToTs(interval.offset),
    })),
    cronString: spec.cronExpressions,
    excludeStructuredCalendar: encodeOptionalStructuredCalendarSpecs(spec.skip),
    startTime: optionalDateToTs(spec.startAt),
    endTime: optionalDateToTs(spec.endAt),
    jitter: msOptionalToTs(spec.jitter),
    timezoneName: spec.timezone,
  };
}

export async function encodeScheduleAction(
  dataConverter: LoadedDataConverter,
  action: CompiledScheduleAction,
  headers: Headers
): Promise<temporal.api.schedule.v1.IScheduleAction> {
  return {
    startWorkflow: {
      workflowId: action.workflowId,
      workflowType: {
        name: action.workflowType,
      },
      input: { payloads: await encodeToPayloads(dataConverter, ...action.args) },
      taskQueue: {
        kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_NORMAL,
        name: action.taskQueue,
      },
      workflowExecutionTimeout: msOptionalToTs(action.workflowExecutionTimeout),
      workflowRunTimeout: msOptionalToTs(action.workflowRunTimeout),
      workflowTaskTimeout: msOptionalToTs(action.workflowTaskTimeout),
      retryPolicy: action.retry ? compileRetryPolicy(action.retry) : undefined,
      memo: action.memo ? { fields: await encodeMapToPayloads(dataConverter, action.memo) } : undefined,
      searchAttributes: action.searchAttributes
        ? {
            indexedFields: mapToPayloads(searchAttributePayloadConverter, action.searchAttributes),
          }
        : undefined,
      header: { fields: headers },
    },
  };
}

export function encodeSchedulePolicies(
  policies?: ScheduleOptions['policies']
): temporal.api.schedule.v1.ISchedulePolicies {
  return {
    catchupWindow: msOptionalToTs(policies?.catchupWindow),
    overlapPolicy: policies?.overlap ? encodeScheduleOverlapPolicy(policies.overlap) : undefined,
    pauseOnFailure: policies?.pauseOnFailure,
  };
}

export function encodeScheduleState(state?: ScheduleOptions['state']): temporal.api.schedule.v1.IScheduleState {
  return {
    paused: state?.paused,
    notes: state?.note,
    limitedActions: state?.remainingActions !== undefined,
    remainingActions: state?.remainingActions ? Long.fromNumber(state?.remainingActions) : undefined,
  };
}

export function decodeScheduleSpec(pb: temporal.api.schedule.v1.IScheduleSpec): ScheduleSpecDescription {
  // Note: the server will have compiled calendar and cron_string fields into
  // structured_calendar (and maybe interval and timezone_name), so at this
  // point, we'll see only structured_calendar, interval, etc.
  return {
    calendars: decodeOptionalStructuredCalendarSpecs(pb.structuredCalendar),
    intervals: (pb.interval ?? []).map(
      (x) =>
        <IntervalSpecDescription>{
          every: optionalTsToMs(x.interval),
          offset: optionalTsToMs(x.phase),
        }
    ),
    skip: decodeOptionalStructuredCalendarSpecs(pb.excludeStructuredCalendar),
    startAt: optionalTsToDate(pb.startTime),
    endAt: optionalTsToDate(pb.endTime),
    jitter: optionalTsToMs(pb.jitter),
    timezone: pb.timezoneName ?? undefined,
  };
}

export async function decodeScheduleAction(
  dataConverter: LoadedDataConverter,
  pb: temporal.api.schedule.v1.IScheduleAction
): Promise<ScheduleDescriptionAction> {
  if (pb.startWorkflow) {
    return {
      type: 'startWorkflow',
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      workflowId: pb.startWorkflow.workflowId!,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      workflowType: pb.startWorkflow.workflowType!.name!,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      taskQueue: pb.startWorkflow.taskQueue!.name!,
      args: await decodeArrayFromPayloads(dataConverter, pb.startWorkflow.input?.payloads),
      memo: await decodeMapFromPayloads(dataConverter, pb.startWorkflow.memo?.fields),
      retry: decompileRetryPolicy(pb.startWorkflow.retryPolicy),
      searchAttributes: Object.fromEntries(
        Object.entries(
          mapFromPayloads(
            searchAttributePayloadConverter,
            pb.startWorkflow.searchAttributes?.indexedFields ?? {}
          ) as SearchAttributes
        )
      ),
      workflowExecutionTimeout: optionalTsToMs(pb.startWorkflow.workflowExecutionTimeout),
      workflowRunTimeout: optionalTsToMs(pb.startWorkflow.workflowRunTimeout),
      workflowTaskTimeout: optionalTsToMs(pb.startWorkflow.workflowTaskTimeout),
    };
  }
  throw new TypeError('Unsupported schedule action');
}

export function decodeSearchAttributes(
  pb: temporal.api.common.v1.ISearchAttributes | undefined | null
): SearchAttributes {
  if (!pb?.indexedFields) return {};
  return Object.fromEntries(
    Object.entries(mapFromPayloads(searchAttributePayloadConverter, pb.indexedFields) as SearchAttributes).filter(
      ([_, v]) => v && v.length > 0
    ) // Filter out empty arrays returned by pre 1.18 servers
  );
}

export function decodeScheduleRunningActions(
  pb?: temporal.api.common.v1.IWorkflowExecution[] | null
): ScheduleExecutionStartWorkflowActionResult[] {
  if (!pb) return [];
  return pb.map(
    (x): ScheduleExecutionStartWorkflowActionResult => ({
      type: 'startWorkflow',
      workflow: {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        workflowId: x.workflowId!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        firstExecutionRunId: x.runId!,
      },
    })
  );
}

export function decodeScheduleRecentActions(
  pb?: temporal.api.schedule.v1.IScheduleActionResult[] | null
): ScheduleExecutionResult[] {
  if (!pb) return [];
  return (pb as Required<temporal.api.schedule.v1.IScheduleActionResult>[]).map(
    (executionResult): ScheduleExecutionResult => {
      let action: ScheduleExecutionActionResult | undefined;
      if (executionResult.startWorkflowResult) {
        action = {
          type: 'startWorkflow',
          workflow: {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            workflowId: executionResult.startWorkflowResult!.workflowId!,
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            firstExecutionRunId: executionResult.startWorkflowResult!.runId!,
          },
        };
      } else throw new TypeError('Unsupported schedule action');

      return {
        scheduledAt: requiredTsToDate(executionResult.scheduleTime, 'scheduleTime'),
        takenAt: requiredTsToDate(executionResult.actualTime, 'actualTime'),
        action,
      };
    }
  );
}
