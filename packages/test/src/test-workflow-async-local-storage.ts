import type { AsyncLocalStorage } from 'async_hooks';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';
import { unblockSignal } from './workflows/testenv-test-workflows';
import { startWorkflow } from '@temporalio/nexus';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [require.resolve('./workflows/otel-interceptors')],
});

export async function asyncLocalStorageWorkflow(explicitlyDisable: boolean): Promise<void> {
  const myAls: AsyncLocalStorage<unknown> = new (globalThis as any).AsyncLocalStorage('My Workflow ALS');
  try {
    await myAls.run({}, async () => {
      let signalReceived = false;
      workflow.setHandler(unblockSignal, () => {
        signalReceived = true;
      });
      await workflow.condition(() => signalReceived);
    });
  } finally {
    if (explicitlyDisable) {
      myAls.disable();
    }
  }
}

test("AsyncLocalStorage in workflow context doesn't throw when disabled", async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    // We disable the workflow cache to ensure that some workflow executions will get
    // evicted from cache, forcing early disposal of the corresponding workflow vms.
    maxCachedWorkflows: 0,
    maxConcurrentWorkflowTaskExecutions: 1,

    sinks: {
      exporters: {
        export: {
          fn: () => void 0,
        },
      },
    },
  });

  await worker.runUntil(async () => {
    const wfs = await Promise.all([
      startWorkflow(asyncLocalStorageWorkflow, { args: [true] }),
      startWorkflow(asyncLocalStorageWorkflow, { args: [false] }),
      startWorkflow(asyncLocalStorageWorkflow, { args: [true] }),
      startWorkflow(asyncLocalStorageWorkflow, { args: [false] }),
    ]);

    await Promise.all([wfs[0].signal(unblockSignal), wfs[1].signal(unblockSignal)]);
    await Promise.all([wfs[0].result(), wfs[1].result()]);
  });

  // We're only asserting that no error is thrown. There's unfortunately no way
  // to programmatically confirm that ALS instances were properly disposed.
  t.pass();
});
