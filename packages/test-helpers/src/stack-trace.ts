import path from 'path';
import StackUtils from 'stack-utils';
import type { ExecutionContext } from 'ava';

export function cleanOptionalStackTrace(stackTrace: string | undefined | null): string | undefined {
  return stackTrace ? cleanStackTrace(stackTrace) : undefined;
}

/**
 * Relativize paths and remove line and column numbers from stack trace.
 *
 * Note: The cwd parameter should be the path to the directory containing the test package
 * (e.g., packages/test, packages/ai-sdk, etc.)
 */
export function cleanStackTrace(ostack: string): string {
  // For some reason, a code snippet with carret on error location is sometime prepended before the actual stacktrace.
  // If there is such a snippet, get rid of it.
  const stack = ostack.replace(/^.*\n[ ]*\^[ ]*\n+/gms, '');

  const su = new StackUtils({ cwd: path.join(__dirname, '../..') });
  const firstLine = stack.split('\n')[0]!;
  const cleanedStack = su.clean(stack).trimEnd();
  let normalizedStack =
    cleanedStack &&
    cleanedStack
      .replace(/:\d+:\d+/g, '')
      .replace(/^\s*/gms, '    at ')
      .replace(/\[as fn\] /, '')
      // Avoid https://github.com/nodejs/node/issues/42417
      .replace(/at null\./g, 'at ')
      .replace(/\\/g, '/');

  // FIXME: Find a better way to handle package vendoring; this will come back again.
  normalizedStack = normalizedStack
    .replaceAll(/\([^() ]*\/node_modules\//g, '(')
    .replaceAll(/\([^() ]*\/nexus-sdk-typescript\/src/g, '(nexus-rpc/src');

  return normalizedStack ? `${firstLine}\n${normalizedStack}` : firstLine;
}
/**
 * Compare stack traces using keywords to match any inconsistent parts of the stack trace
 *
 * As of Node 24.6.0 type names are now present on source mapped stack traces which leads
 * to different stack traces depending on Node version.
 * See [f33e0fcc83954f728fcfd2ef6ae59435bc4af059](https://github.com/nodejs/node/commit/f33e0fcc83954f728fcfd2ef6ae59435bc4af059)
 *
 * Bun does not support promise hooks meaning we are currently unable to apply the source map on stack traces and workflow bundles
 * end up in the stack trace.
 *
 * Special:
 * - $CLASS: used to match class names that might be inconsistent
 * - $HASH: used to match bundle hash suffixes in workflow paths
 */
export function compareStackTrace(t: ExecutionContext, actual: string, expected: string): void {
  const escapedTrace = expected
    .replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
    .replace(/-/g, '\\x2d')
    .replaceAll('\\$CLASS', '(?:[A-Za-z]+)')
    .replaceAll('\\$HASH', '(?:[A-Za-z0-9]+)');
  t.regex(actual, RegExp(`^${escapedTrace}$`));
}
