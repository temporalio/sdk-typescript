import type { AsyncLocalStorage } from 'async_hooks';
import * as workflow from '@temporalio/workflow';
import { unblockSignal } from './testenv-test-workflows';

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
