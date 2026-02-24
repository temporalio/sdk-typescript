/**
 * Sleep for a given number of milliseconds
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
