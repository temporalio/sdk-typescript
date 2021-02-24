import { cancel, cancellationScope, sleep } from '@temporalio/workflow';

export async function main(): Promise<void> {
  {
    const promise = Promise.resolve();
    try {
      cancel(promise);
    } catch (e) {
      console.log(e.message);
    }
  }
  await cancellationScope(async () => {
    const promise = (async () => {
      await sleep(3);
    })();
    try {
      cancel(promise);
    } catch (e) {
      console.log(e.message);
    }
  });
}
