import type { AfterFn, AlwaysInterface, FailingFn, OnlyFn, SerialFn, TestFn } from 'ava';
import ava from 'ava';
import { inWorkflowContext } from '@temporalio/workflow';
import { isSet } from './flags';

function noopTest(): void {
  // eslint: this function body is empty and it's okay.
}

noopTest.serial = () => undefined;
noopTest.macro = () => undefined;
noopTest.before = () => undefined;
noopTest.after = () => undefined;
(noopTest.after as any).always = () => undefined;
noopTest.beforeEach = () => undefined;
noopTest.afterEach = () => undefined;
noopTest.skip = () => noopTest;

/**
 * (Mostly complete) helper to allow mixing workflow and non-workflow code in the same test file.
 */
export const test: TestFn<unknown> = inWorkflowContext() ? (noopTest as any) : ava;

function assertReason(reason: string): void {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new TypeError('A non-empty reason is required for a local-server-only test');
  }
}

function localServerSkipTitle(title: string, reason: string): string {
  return `${title} (requires local server: ${reason})`;
}

/**
 * Return a test function which skips its tests and hooks when the integration suite is configured to use envconfig.
 *
 * Local-server requirements must always include a reason so Cloud output makes the excluded capability explicit.
 */
export function requiresLocalServer<Context = unknown>(reason: string, baseTest?: TestFn<Context>): TestFn<Context> {
  assertReason(reason);
  const source = (baseTest ?? test) as TestFn<Context>;
  if (inWorkflowContext()) {
    return source;
  }
  if (!isSet(process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER, false)) {
    return source;
  }

  const skip = ((titleOrMacro: any, implementation?: any, ...args: any[]) => {
    if (typeof titleOrMacro === 'string') {
      source.skip(localServerSkipTitle(titleOrMacro, reason), implementation, ...args);
    } else {
      // AVA macros generate their own title, so they cannot be decorated without changing their public contract.
      if (implementation === undefined) source.skip(titleOrMacro, ...args);
      else source.skip(titleOrMacro, implementation, ...args);
    }
  }) as TestFn<Context>['skip'];

  // Skip hooks as well as tests: suite setup must not create a local server in envconfig mode.
  const noopHook = (() => undefined) as any;
  const before = (source.before.skip ?? noopHook) as TestFn<Context>['before'];
  const after = (source.after.skip ?? noopHook) as AfterFn<Context>;
  after.always = ((source.after as any).always?.skip ?? noopHook) as AlwaysInterface<Context>;
  const beforeEach = (source.beforeEach.skip ?? noopHook) as TestFn<Context>['beforeEach'];
  const afterEach = (source.afterEach.skip ?? noopHook) as AfterFn<Context>;
  afterEach.always = ((source.afterEach as any).always?.skip ?? noopHook) as AlwaysInterface<Context>;
  const serial = skip as SerialFn<Context>;
  serial.before = before;
  serial.after = after;
  serial.beforeEach = beforeEach;
  serial.afterEach = afterEach;
  serial.failing = skip as FailingFn<Context>;
  serial.only = skip as OnlyFn<Context>;
  serial.skip = skip;
  serial.todo = source.todo;
  const failing = skip as FailingFn<Context>;
  failing.only = skip as OnlyFn<Context>;
  failing.skip = skip;
  const skipped = skip as TestFn<Context>;
  skipped.before = before;
  skipped.after = after;
  skipped.beforeEach = beforeEach;
  skipped.afterEach = afterEach;
  skipped.serial = serial;
  skipped.failing = failing;
  skipped.only = skip as OnlyFn<Context>;
  skipped.skip = skip;
  skipped.todo = source.todo;
  skipped.macro = source.macro;
  skipped.meta = source.meta;
  return skipped;
}

export { noopTest };
