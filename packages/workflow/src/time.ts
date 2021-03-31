import Long from 'long';
import ms from 'ms';
import * as iface from '@temporalio/proto';

// NOTE: these are the same interface in JS
// iface.google.protobuf.IDuration;
// iface.google.protobuf.ITimestamp;
// The conversion functions below should work for both

export type Timestamp = iface.google.protobuf.ITimestamp;

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

export function msToTs(millis: number): Timestamp {
  const seconds = Math.floor(millis / 1000);
  const nanos = (millis % 1000) * 1000000;
  return { seconds: Long.fromNumber(seconds), nanos };
}

export function msStrToTs(str: string): Timestamp {
  return msToTs(ms(str));
}

export function msOptionalStrToTs(str: string | undefined): Timestamp | undefined {
  if (str === undefined) return undefined;
  return msToTs(ms(str));
}

export function nullToUndefined<T extends any | null | undefined>(x: T): Exclude<T, null> {
  if (x === null) return undefined as any;
  return x as any;
}
