/**
 * Common library for code that's used across the Client, Worker, and/or Workflow
 *
 * @module
 */
export { Headers, Next } from './interceptors';

export * from './activity-options';
export * from './converter/data-converter';
export * from './converter/failure-converter';
export * from './converter/payload-codec';
export * from './converter/payload-converter';
export * from './converter/types';
export * from './errors';
export * from './failure';
export * from './failure';
export * from './interfaces';
export * from './retry-policy';
export { Timestamp } from './time';
export * from './workflow-options';
export * from './workflow-handle';
export * from './deprecated-time';

import * as encoding from './encoding';
import * as helpers from './type-helpers';

/**
 * Encode a UTF-8 string into a Uint8Array
 *
 * @hidden
 * @deprecated - meant for internal use only
 */
export function u8(s: string): Uint8Array {
  return encoding.encode(s);
}

/**
 * Decode a Uint8Array into a UTF-8 string
 *
 * @hidden
 * @deprecated - meant for internal use only
 */
export function str(arr: Uint8Array): string {
  return encoding.decode(arr);
}

/**
 * Get `error.message` (or `undefined` if not present)
 *
 * @hidden
 * @deprecated - meant for internal use only
 */
export function errorMessage(error: unknown): string | undefined {
  return helpers.errorMessage(error);
}

/**
 * Get `error.code` (or `undefined` if not present)
 *
 * @hidden
 * @deprecated - meant for internal use only
 */
export function errorCode(error: unknown): string | undefined {
  return helpers.errorCode(error);
}
