/**
 * The workflow VM's global handlers (a V8 promise hook and an Error.prepareStackTrace override) are global to the
 * isolate. In debug mode, which `Worker.runReplayHistory` always uses, they run on the host application's main thread.
 * These tests pin two things the host application relies on there:
 *  - the promise hook never throws on a promise from outside any workflow, whatever its `constructor` is;
 *  - the handlers are removed when the last workflow creator that installed them is destroyed.
 */
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'ava';
import { bundleWorkflowCode } from '@temporalio/worker';
import { parseWorkflowCode } from '@temporalio/worker/lib/worker';
import { VMWorkflowCreator } from '@temporalio/worker/lib/workflow/vm';
import { ReusableVMWorkflowCreator } from '@temporalio/worker/lib/workflow/reusable-vm';
import { globalHandlers } from '@temporalio/worker/lib/workflow/vm-shared';

/**
 * Settle a pending promise whose own `constructor` property is `undefined`. Node's WebCrypto (v26.11+) does this to
 * its internal job promises, and any user code can do it too.
 */
function settlePromiseWithoutConstructor(): void {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((r) => (resolve = r));
  Object.defineProperty(promise, 'constructor', { value: undefined });
  resolve(1);
}

async function collectUncaughtExceptions(fn: () => void): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    fn();
    await nextTurn();
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  return uncaught;
}

test.serial('promise hook ignores a non-workflow promise whose constructor is not a function', async (t) => {
  globalHandlers.install();
  try {
    t.true(globalHandlers.promiseHookInstalled, 'v8.promiseHooks is required for this test');
    const uncaught = await collectUncaughtExceptions(settlePromiseWithoutConstructor);
    t.deepEqual(uncaught, []);
  } finally {
    globalHandlers.release();
  }
});

for (const Creator of [VMWorkflowCreator, ReusableVMWorkflowCreator]) {
  test.serial(`${Creator.name}: destroying the last creator removes the global handlers`, async (t) => {
    const originalPrepareStackTrace = Error.prepareStackTrace;
    const bundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows/success-string') });
    const code = parseWorkflowCode(bundle.code);

    const first = await Creator.create(code, 4000, new Set());
    const second = await Creator.create(code, 4000, new Set());
    t.true(globalHandlers.installed);

    await first.destroy();
    t.true(globalHandlers.installed, 'another creator still uses the handlers');

    await second.destroy();
    t.false(globalHandlers.installed);
    t.false(globalHandlers.promiseHookInstalled);
    t.is(Error.prepareStackTrace, originalPrepareStackTrace);
  });
}
