/**
 * Minimal integration-test harness for `@temporalio/workflow-streams` tests.
 *
 * Mirrors the slice of `packages/test/src/helpers-integration.ts` that these
 * tests actually use: a `makeTestFunction` that wires up a TestWorkflowEnvironment
 * and a prebuilt workflow bundle in `test.before`, and a `helpers(t)` that
 * surfaces `createWorker` / `startWorkflow` per test.
 */

import type { ExecutionContext, TestFn } from 'ava';
import {
  test as anyTest,
  helpers as baseHelpers,
  createTestWorkflowEnvironment,
  createTestWorkflowBundle,
  type BaseContext,
  type BaseHelpers,
  type TestWorkflowEnvironment,
} from '@temporalio/test-helpers';

export interface Context extends BaseContext<TestWorkflowEnvironment> {}

export interface TestFunctionOptions {
  workflowsPath: string;
}

export function makeTestFunction(opts: TestFunctionOptions): TestFn<Context> {
  const test = anyTest as TestFn<Context>;
  test.before(async (t) => {
    const env = await createTestWorkflowEnvironment();
    const workflowBundle = await createTestWorkflowBundle({ workflowsPath: opts.workflowsPath });
    t.context = { env, workflowBundle };
  });
  test.after.always(async (t) => {
    await t.context.env?.teardown();
  });
  return test;
}

export function helpers(t: ExecutionContext<Context>): BaseHelpers {
  return baseHelpers(t, t.context.env);
}
