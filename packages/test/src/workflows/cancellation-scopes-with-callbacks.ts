/**
 * Demonstrates how to use cancellation scopes with callbacks.
 * Used in the documentation site.
 */
// @@@SNIPSTART typescript-cancellation-scopes-with-callbacks
import { CancellationScope } from '@temporalio/workflow';

function doSomething(callback: () => any) {
  setTimeout(callback, 10);
}

export async function cancellationScopesWithCallbacks(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    doSomething(resolve);
    CancellationScope.current().cancelRequested.catch(reject);
  });
}
// @@@SNIPEND
