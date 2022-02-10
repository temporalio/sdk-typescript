import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { echo } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function throwUnhandledRejection({ crashWorker }: { crashWorker: boolean }): Promise<void> {
  const p1 = (async () => {
    await echo('a');
  })();

  const p2 = (async () => {
    if (crashWorker) {
      // Create a Promise associated with the worker thread context
      const Promise = globalThis.constructor.constructor('return Promise')();
      Promise.reject(new Error('error to crash the worker'));
    } else {
      const cause = new Error('root failure');
      const e: any = new Error('unhandled rejection');
      e.cause = cause;
      throw e;
    }
  })();

  await p1;
  await p2;
}
