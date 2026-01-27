/**
 * Helpers for running tests with Bun runtime
 */

import type { ExecutionContext } from 'ava';

/**
 * Returns true if running under Bun runtime
 */
export const isBun = typeof (globalThis as any).Bun !== 'undefined';

/**
 * Transform a stack trace string for Bun compatibility.
 * Bun's source maps may show compiled .js paths instead of source .ts paths.
 *
 * @param stackTrace - The expected stack trace with .ts paths
 * @returns The stack trace with .js paths if running on Bun, otherwise unchanged
 */
export function transformStackTraceForBun(stackTrace: string): string {
  if (!isBun) return stackTrace;
  return stackTrace.replace(/\.ts\)/g, '.js)').replace(/\.ts$/gm, '.js');
}

/**
 * Get the expected cancelled failure structure based on runtime.
 *
 * Bun preserves the original abort reason (CancelledFailure with message),
 * while node-fetch wraps the abort in a generic AbortError (no message).
 *
 * @param cancelReason - The cancel reason string (e.g., 'CANCELLED', 'NOT_FOUND')
 */
export function getExpectedCancelledFailure(cancelReason = 'CANCELLED'): {
  cancelled: { failure: Record<string, unknown> };
} {
  if (isBun) {
    // Bun preserves the original CancelledFailure with its message
    return {
      cancelled: {
        failure: {
          source: 'TypeScriptSDK',
          message: cancelReason,
          canceledFailureInfo: {},
        },
      },
    };
  }
  // Node.js + node-fetch wraps the abort reason, losing the message
  return {
    cancelled: {
      failure: {
        source: 'TypeScriptSDK',
        canceledFailureInfo: {},
      },
    },
  };
}

/**
 * Check if the stack trace contains expected file references.
 * On Bun, allows .js paths; on Node, expects .ts paths.
 *
 * @param stackTrace - The actual stack trace
 * @param expectedFilePattern - A regex pattern or string to match (with .ts extension)
 * @returns true if the stack trace matches the expected pattern
 */
export function stackTraceContainsFile(stackTrace: string, expectedFilePattern: string): boolean {
  const pattern = isBun ? expectedFilePattern.replace(/\.ts/g, '.[jt]s') : expectedFilePattern;
  return new RegExp(pattern).test(stackTrace);
}
