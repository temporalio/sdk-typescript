import Long from 'long';
import ms from 'ms';
import type * as iface from '@temporalio/proto/lib/coresdk';
import { ValueError } from './errors';

// NOTE: these are the same interface in JS
// iface.google.protobuf.IDuration;
// iface.google.protobuf.ITimestamp;
// The conversion functions below should work for both

export type Timestamp = iface.google.protobuf.ITimestamp;

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

export function falsyMsToTs(str: string | number | undefined): Timestamp | undefined {
  return str ? msToTs(str) : undefined;
}

export function msToTs(str: string | number): Timestamp {
  if (typeof str === 'number') {
    return msNumberToTs(str);
  }
  return msNumberToTs(ms(str));
}

export function msOptionalToTs(str: string | number | undefined): Timestamp | undefined {
  if (str === undefined) return undefined;
  if (typeof str === 'number') {
    return msNumberToTs(str);
  }
  return msNumberToTs(ms(str));
}

export function msOptionalToNumber(val: string | number | undefined): number | undefined {
  if (val === undefined) return undefined;
  return msToNumber(val);
}

export function msToNumber(val: string | number): number {
  if (typeof val === 'number') {
    return val;
  }
  return ms(val);
}
