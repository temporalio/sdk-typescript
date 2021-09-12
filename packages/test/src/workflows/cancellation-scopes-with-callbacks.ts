/**
 * Demonstrates how to use cancellation scopes with callbacks.
 * Used in the documentation site.
 */
// @@@SNIPSTART nodejs-cancellation-scopes-with-callbacks
import { CancellationScope } from '@temporalio/workflow';
import { Empty } from '../interfaces';

function doSomehing(callback: () => any) {
  setTimeout(callback, 10);
}

export const cancellationScopesWithCallbacks: Empty = () => ({
  async execute() {
    await new Promise<void>((resolve, reject) => {
      doSomehing(resolve);
      CancellationScope.current().cancelRequested.catch(reject);
    });
  },
});
// @@@SNIPEND
