import type { ExecutionContext } from 'ava';

/**
 * Sleep for a given number of milliseconds
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Repeatedly run an assertion callback until it passes, or until a timeout elapses.
 *
 * Each attempt runs inside ava's `t.try()`, so failing intermediate attempts (including ones that
 * throw, e.g. reading a metric line that isn't present yet) are discarded and do not fail the test.
 * The final attempt is committed, so a genuine failure is reported with its normal assertion
 * diagnostics and logs.
 *
 * Use this for state that only becomes true asynchronously (e.g. metrics that Core exports to its
 * Prometheus endpoint on a delay). The check is written once, as the assertion, instead of being
 * duplicated as both a `waitUntil` predicate and a separate assertion.
 */
export async function assertEventually<Context = unknown>(
  t: ExecutionContext<Context>,
  assertion: (t: ExecutionContext<Context>) => void | Promise<void>,
  timeoutMs = 10000,
  intervalMs = 100
): Promise<void> {
  const endTime = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await t.try(async (tt) => {
      await assertion(tt);
    });
    if (attempt.passed || Date.now() >= endTime) {
      attempt.commit();
      return;
    }
    attempt.discard();
    await sleep(intervalMs);
  }
}

/**
 * Wait until a condition is met or timeout
 */
export async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 100
): Promise<void> {
  const endTime = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) {
      return;
    } else if (Date.now() >= endTime) {
      throw new Error('timed out waiting for condition');
    } else {
      await sleep(intervalMs);
    }
  }
}

/**
 * Convert a string to Uint8Array
 */
export function u8(s: string): Uint8Array {
  // TextEncoder requires lib "dom"
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return new TextEncoder().encode(s);
}

/**
 * Check if two numbers are approximately equal within a tolerance
 */
export function approximatelyEqual(
  a: number | null | undefined,
  b: number | null | undefined,
  tolerance = 0.000001
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  return Math.abs(a - b) < tolerance;
}
