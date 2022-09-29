/**
 * Common library for code that's used across the Client, Worker, and/or Workflow
 *
 * @module
 */
export * from './activity-options';
export * from './converter/data-converter';
export * from './converter/failure-converter';
export * from './converter/payload-codec';
export * from './converter/payload-converter';
export * from './converter/types';
export * from './deprecated-time';
export * from './errors';
export * from './failure';
export { Headers, Next } from './interceptors';
export * from './interfaces';
export * from './retry-policy';
export { Timestamp } from './time';
export { errorCode, errorMessage } from './type-helpers';
export * from './workflow-handle';
export * from './workflow-options';

import * as encoding from './encoding';

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
