/**
 * Bundling test for `@temporalio/workflow-streams`.
 *
 * Runs the real `bundleWorkflowCode` walker (no `ignoreModules` allowlist) against
 * a workflow file that imports from `@temporalio/workflow-streams/workflow`.
 * The workflow entrypoint must not transitively reach `crypto`, `@temporalio/activity`,
 * or `@temporalio/client`, otherwise the workflow sandbox check fails.
 */

import type { TestFn } from 'ava';
import anyTest from 'ava';
import { bundleWorkflowCode } from '@temporalio/worker';

const test = anyTest as TestFn;

test('workflow streams workflow entrypoint can be bundled', async (t) => {
  await t.notThrowsAsync(
    bundleWorkflowCode({
      workflowsPath: require.resolve('./workflows/workflow-streams'),
    })
  );
});
