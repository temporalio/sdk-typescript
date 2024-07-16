import { CancellationScope, sleep } from '@temporalio/workflow';

export async function childAndNonCancellable(): Promise<void> {
  const child = new CancellationScope();
  const promise = child.run(async () => {
    await CancellationScope.nonCancellable(async () => {
      await sleep(5);
      console.log('Slept in non-cancellable scope 👍');
    });
  });
  child.cancel();
  await promise;
}
