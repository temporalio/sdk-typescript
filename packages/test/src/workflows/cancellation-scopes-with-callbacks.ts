// @@@SNIPSTART nodejs-cancellation-scopes-with-callbacks
import { CancellationScope } from '@temporalio/workflow';

function doSomehing(callback: () => any) {
  setTimeout(callback, 10);
}

export async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    CancellationScope.cancellable(async () => {
      doSomehing(resolve);
      CancellationScope.current().cancelRequested.catch(reject);
    });
  });
}
// @@@SNIPEND
