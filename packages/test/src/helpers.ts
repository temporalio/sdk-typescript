import path from 'path';
import StackUtils from 'stack-utils';

export function u8(s: string): Uint8Array {
  // TextEncoder requires lib "dom"
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return new TextEncoder().encode(s);
}

export function isSet(env: string | undefined): boolean {
  if (env === undefined) return false;
  env = env.toLocaleLowerCase();
  return env === '1' || env === 't' || env === 'true';
}

export const RUN_INTEGRATION_TESTS = isSet(process.env.RUN_INTEGRATION_TESTS);

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cleanOptionalStackTrace(stackTrace: string | undefined | null): string | undefined {
  return stackTrace ? cleanStackTrace(stackTrace) : undefined;
}

/**
 * Relativize paths and remove line and column numbers from stack trace
 */
export function cleanStackTrace(stack: string): string {
  const su = new StackUtils({ cwd: path.join(__dirname, '../..') });
  const cleaned = su.clean(stack).trimEnd();
  return stack.split('\n')[0] + '\n' + (cleaned && cleaned.replace(/:\d+:\d+/g, '').replace(/^/gms, '    at '));
}

export function containsMatching(strings: string[], regex: RegExp): boolean {
  console.log('strings:', strings);
  return strings.some((str) => regex.test(str));
}
