/**
 * Demonstrates how to use cancellation scopes with callbacks.
 * Used in the documentation site.
 */
// @@@SNIPSTART nodejs-cancellation-scopes-with-callbacks
import { CancellationScope } from '@temporalio/workflow';

function doSomehing(callback: () => any) {
  setTimeout(callback, 10);
}

export async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    doSomehing(resolve);
    CancellationScope.current().cancelRequested.catch(reject);
  });
}
// @@@SNIPEND
