import Long from 'long'; // eslint-disable-line import/no-named-as-default
import ms, { StringValue } from 'ms';
import type { google } from '@temporalio/proto';
import { ValueError } from './errors';

// NOTE: these are the same interface in JS
// google.protobuf.IDuration;
// google.protobuf.ITimestamp;
// The conversion functions below should work for both

export type Timestamp = google.protobuf.ITimestamp;

/**
 * A duration, expressed either as a number of milliseconds, or as a {@link https://www.npmjs.com/package/ms | ms-formatted string}.
 */
export type Duration = StringValue | number;

export type { StringValue } from 'ms';

/**
 * Lossy conversion function from Timestamp to number due to possible overflow.
 * If ts is null or undefined returns undefined.
 */
export function optionalTsToMs(ts: Timestamp | null | undefined): number | undefined {
  if (ts === undefined || ts === null) {
    return undefined;
  }
  return tsToMs(ts);
}

/**
 * Lossy conversion function from Timestamp to number due to possible overflow.
 * If ts is null or undefined, throws a TypeError, with error message including the name of the field.
 */
export function requiredTsToMs(ts: Timestamp | null | undefined, fieldName: string): number {
  if (ts === undefined || ts === null) {
    throw new TypeError(`Expected ${fieldName} to be a timestamp, got ${ts}`);
  }
  return tsToMs(ts);
}

/**
 * Lossy conversion function from Timestamp to number due to possible overflow
 */
export function tsToMs(ts: Timestamp | null | undefined): number {
  if (ts === undefined || ts === null) {
    throw new Error(`Expected timestamp, got ${ts}`);
  }
  const { seconds, nanos } = ts;
  return (seconds || Long.UZERO)
    .mul(1000)
    .add(Math.floor((nanos || 0) / 1000000))
    .toNumber();
}

export function msNumberToTs(millis: number): Timestamp {
  const seconds = Math.floor(millis / 1000);
  const nanos = (millis % 1000) * 1000000;
  if (Number.isNaN(seconds) || Number.isNaN(nanos)) {
    throw new ValueError(`Invalid millis ${millis}`);
  }
  return { seconds: Long.fromNumber(seconds), nanos };
}

export function msToTs(str: Duration): Timestamp {
  return msNumberToTs(msToNumber(str));
}

export function msOptionalToTs(str: Duration | undefined | null): Timestamp | undefined {
  return str ? msToTs(str) : undefined;
}

export function msOptionalToNumber(val: Duration | undefined): number | undefined {
  if (val === undefined) return undefined;
  return msToNumber(val);
}

export function msToNumber(val: Duration): number {
  if (typeof val === 'number') {
    return val;
  }
  return msWithValidation(val);
}

function msWithValidation(str: StringValue): number {
  const millis = ms(str);
  if (millis == null || isNaN(millis)) {
    throw new TypeError(`Invalid duration string: '${str}'`);
  }
  return millis;
}

export function tsToDate(ts: Timestamp): Date {
  return new Date(tsToMs(ts));
}

// ts-prune-ignore-next
export function requiredTsToDate(ts: Timestamp | null | undefined, fieldName: string): Date {
  return new Date(requiredTsToMs(ts, fieldName));
}

export function optionalTsToDate(ts: Timestamp | null | undefined): Date | undefined {
  if (ts === undefined || ts === null) {
    return undefined;
  }
  return new Date(tsToMs(ts));
}

// ts-prune-ignore-next (imported via schedule-helpers.ts)
export function optionalDateToTs(date: Date | null | undefined): Timestamp | undefined {
  if (date === undefined || date === null) {
    return undefined;
  }
  return msToTs(date.getTime());
}
