import * as time from './time';
import type { Duration } from './time';
import { type Timestamp } from './time';

/**
 * Lossy conversion function from Timestamp to number due to possible overflow.
 * If ts is null or undefined returns undefined.
 *
 * @internal
 * @deprecated - meant for internal use only
 */
export function optionalTsToMs(ts: Timestamp | null | undefined): number | undefined {
  return time.optionalTsToMs(ts);
}

/**
 * Lossy conversion function from Timestamp to number due to possible overflow
 *
 * @internal
 * @deprecated - meant for internal use only
 */
export function tsToMs(ts: Timestamp | null | undefined): number {
  return time.tsToMs(ts);
}

/**
 * @internal
 * @deprecated - meant for internal use only
 */
export function msNumberToTs(millis: number): Timestamp {
  return time.msNumberToTs(millis);
}

/**
 * @internal
 * @deprecated - meant for internal use only
 */
export function msToTs(str: Duration): Timestamp {
  return time.msToTs(str);
}

/**
 * @internal
 * @deprecated - meant for internal use only
 */
export function msOptionalToTs(str: Duration | undefined): Timestamp | undefined {
  return time.msOptionalToTs(str);
}

/**
 * @internal
 * @deprecated - meant for internal use only
 */
export function msOptionalToNumber(val: Duration | undefined): number | undefined {
  return time.msOptionalToNumber(val);
}

/**
 * @internal
 * @deprecated - meant for internal use only
 */
export function msToNumber(val: Duration): number {
  return time.msToNumber(val);
}

/**
 * @internal
 * @deprecated - meant for internal use only
 */
export function tsToDate(ts: Timestamp): Date {
  return time.tsToDate(ts);
}

/**
 * @internal
 * @deprecated - meant for internal use only
 */
export function optionalTsToDate(ts: Timestamp | null | undefined): Date | undefined {
  return time.optionalTsToDate(ts);
}
