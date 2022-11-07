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
  CalendarSpec,
  CalendarSpecDescription,
  CompiledScheduleOptions,
  CompiledScheduleUpdateOptions,
  IntervalSpecDescription,
  ScheduleSummary,
  Range,
  ScheduleDescription,
  ScheduleOptions,
  ScheduleOverlapPolicy,
  ScheduleUpdateOptions,
  ScheduleExecutionActionResult,
  ScheduleExecutionResult,
  DayOfWeek,
  DaysOfWeek,
  Month,
  Months,
  LooseRange,
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
    input: LooseRange<X> | LooseRange<X>[] | '*' | undefined
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

export function encodeOptionalStructuredCalendarSpecs(
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

export function decodeOptionalStructuredCalendarSpecs(
  input: temporal.api.schedule.v1.IStructuredCalendarSpec[] | null | undefined
): CalendarSpecDescription[] {
  if (!input) return [];

  return input.map(
    (spec): CalendarSpecDescription => ({
      second: calendarSpecFieldEncoders.second.decoder(spec.second),
      minute: calendarSpecFieldEncoders.minute.decoder(spec.minute),
      hour: calendarSpecFieldEncoders.hour.decoder(spec.hour),
      dayOfMonth: calendarSpecFieldEncoders.dayOfMonth.decoder(spec.dayOfMonth),
      month: calendarSpecFieldEncoders.month.decoder(spec.month),
      year: calendarSpecFieldEncoders.year.decoder(spec.year),
      dayOfWeek: calendarSpecFieldEncoders.dayOfWeek.decoder(spec.dayOfWeek),
      comment: spec.comment!,
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

// FIXME-JWH: Consider use a hash lookup for name to number
function dayOfWeekNameToNumber(day: DayOfWeek): number | undefined {
  const index = DaysOfWeek.indexOf(day);
  return index >= 0 ? index : undefined;
}

function dayOfWeekNumberToName(day: number): DayOfWeek {
  return DaysOfWeek[day];
}

// FIXME-JWH: Consider use a hash lookup for name to number
function monthNameToNumber(month: Month): number | undefined {
  const index = Months.indexOf(month);
  return index >= 0 ? index + 1 : undefined;
}

function monthNumberToName(month: number): Month {
  return Months[month - 1];
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

export async function encodeSchedule(
  dataConverter: LoadedDataConverter,
  opts: CompiledScheduleOptions | CompiledScheduleUpdateOptions,
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
        input: { payloads: await encodeToPayloads(dataConverter, ...opts.action.args) },
        taskQueue: {
          kind: temporal.api.enums.v1.TaskQueueKind.TASK_QUEUE_KIND_UNSPECIFIED,
          name: opts.action.taskQueue,
        },
        workflowExecutionTimeout: msOptionalToTs(opts.action.workflowExecutionTimeout),
        workflowRunTimeout: msOptionalToTs(opts.action.workflowRunTimeout),
        workflowTaskTimeout: msOptionalToTs(opts.action.workflowTaskTimeout),
        retryPolicy: opts.action.retry ? compileRetryPolicy(opts.action.retry) : undefined,
        memo: opts.action.memo ? { fields: await encodeMapToPayloads(dataConverter, opts.action.memo) } : undefined,
        searchAttributes: opts.action.searchAttributes
          ? {
              indexedFields: mapToPayloads(searchAttributePayloadConverter, opts.action.searchAttributes),
            }
          : undefined,
        header: { fields: headers },
      },
    },
    policies: {
      catchupWindow: msOptionalToTs(opts.policies?.catchupWindow),
      overlapPolicy: opts.policies?.overlap ? encodeOverlapPolicy(opts.policies.overlap) : undefined,
      pauseOnFailure: opts.policies?.pauseOnFailure,
    },
    state: {
      notes: opts.state?.note,
      limitedActions: opts.state?.remainingActions !== undefined,
      remainingActions: opts.state?.remainingActions ? Long.fromNumber(opts.state?.remainingActions) : undefined,
    },
  };
}
