import { CancellationScope, sleep } from '@temporalio/workflow';

export async function execute(): Promise<void> {
  const child = new CancellationScope();
  const promise = child.run(async () => {
    await CancellationScope.nonCancellable(async () => {
      await sleep(5);
      console.log('Slept in shield 👍');
    });
  });
  child.cancel();
  await promise;
}
