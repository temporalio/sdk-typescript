import { CancellationScope, sleep } from '@temporalio/workflow';

export async function main(): Promise<void> {
  await CancellationScope.cancellable(async () => {
    const promise = sleep(0);
    CancellationScope.current().cancel();
    await promise;
  });
}
