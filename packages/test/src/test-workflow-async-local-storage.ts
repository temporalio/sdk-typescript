import type { AsyncLocalStorage } from 'async_hooks';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [require.resolve('./workflows/otel-interceptors')],
});

export async function asyncLocalStorageWorkflow(): Promise<void> {
  const myAls: AsyncLocalStorage<unknown> = new (globalThis as any).AsyncLocalStorage('My Workflow ALS');
  try {
    await myAls.run({}, async () => {
      console.log('My Workflow ALS');
      await workflow.sleep(3000);
    });
  } finally {
    myAls.disable();
  }
}

test('AsyncLocalStorage in workflow context', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker();

  const wf1 = await startWorkflow(asyncLocalStorageWorkflow);
  const wf2 = await startWorkflow(asyncLocalStorageWorkflow);
  const wf3 = await startWorkflow(asyncLocalStorageWorkflow);

  await worker.runUntil(Promise.all([wf1.result(), wf2.result(), wf3.result()]));
  t.pass();
});
