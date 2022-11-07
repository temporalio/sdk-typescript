import {
  compileRetryPolicy,
  LoadedDataConverter,
  mapToPayloads,
  searchAttributePayloadConverter,
} from '@temporalio/common';
import { Headers } from '@temporalio/common/lib/interceptors';
import { encodeMapToPayloads, encodeToPayloads } from '@temporalio/common/lib/internal-non-workflow';
import {
  CalendarSpec,
  CalendarSpecDescription,
  CompiledScheduleOptions,
  CompiledScheduleUpdateOptions,
  Range,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleUpdateOptions,
  DayOfWeek,
  DaysOfWeek,
  Month,
  Months,
  LooseRange,
  ScheduleSpec,
  ScheduleOptionsAction,
  CompiledScheduleAction,
} from './schedule-types';
import { temporal } from '@temporalio/proto';
import { msOptionalToTs, msToTs, optionalDateToTs } from '@temporalio/common/lib/time';
import Long from 'long';

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
  (x: number) => (typeof x === 'number' && x >= 0 && x <= 59 ? x : undefined),
  (x: number) => x,
  [{ start: 0, end: 0, step: 0 }], // default to 0
  [{ start: 0, end: 23, step: 1 }]
);

const [encodeDayOfMonth, decodeDayOfMonth] = makeCalendarSpecFieldCoders(
  'dayOfMonth',
  (x: number) => (typeof x === 'number' && x >= 0 && x <= 6 ? x : undefined),
  (x: number) => x,
  [{ start: 1, end: 31, step: 1 }], // default to *
  [{ start: 1, end: 31, step: 1 }]
);

const [encodeMonth, decodeMonth] = makeCalendarSpecFieldCoders(
  'month',
  function monthNameToNumber(month: Month): number | undefined {
    const index = Months.indexOf(month);
    return index >= 0 ? index + 1 : undefined;
  },
  (month: number) => Months[month - 1],
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
    const index = DaysOfWeek.indexOf(day);
    return index >= 0 ? index : undefined;
  },
  (day: number) => DaysOfWeek[day],
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
      throw new Error(`Invalid CalendarSpec component for field ${fieldName}: '${item}' of type '${typeof item}'`);
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

export function encodeOverlapPolicy(input: ScheduleOverlapPolicy): temporal.api.enums.v1.ScheduleOverlapPolicy {
  return temporal.api.enums.v1.ScheduleOverlapPolicy[
    `SCHEDULE_OVERLAP_POLICY_${ScheduleOverlapPolicy[input] as keyof typeof ScheduleOverlapPolicy}`
  ];
}

export function decodeOverlapPolicy(input: temporal.api.enums.v1.ScheduleOverlapPolicy): ScheduleOverlapPolicy {
  const encodedPolicyName = temporal.api.enums.v1.ScheduleOverlapPolicy[input];
  const decodedPolicyName = encodedPolicyName.substring(
    'SCHEDULE_OVERLAP_POLICY_'.length
  ) as keyof typeof ScheduleOverlapPolicy;
  return ScheduleOverlapPolicy[decodedPolicyName];
}

export function compileScheduleOptions(options: ScheduleOptions): CompiledScheduleOptions {
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

export function compileUpdatedScheduleOptions(options: ScheduleUpdateOptions): CompiledScheduleUpdateOptions {
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
        kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
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
    overlapPolicy: policies?.overlap ? encodeOverlapPolicy(policies.overlap) : undefined,
    pauseOnFailure: policies?.pauseOnFailure,
  };
}

export function encodeScheduleState(state?: ScheduleOptions['state']): temporal.api.schedule.v1.IScheduleState {
  return {
    notes: state?.note,
    limitedActions: state?.remainingActions !== undefined,
    remainingActions: state?.remainingActions ? Long.fromNumber(state?.remainingActions) : undefined,
  };
}
