/**
 * Tests that cancellation scopes are correctly associated when resumed after completion
 *
 * @module
 */

import { CancellationScope, CancelledFailure } from '@temporalio/workflow';
import { httpGet } from './configured-activities';

export function cancelActivityAfterFirstCompletion(url: string): { execute(): Promise<string[]> } {
  return {
    async execute() {
      const promise = CancellationScope.nonCancellable(async () => {
        return [
          await httpGet(url),
          await httpGet(url), // <-- This activity should still be shielded
        ];
      });
      try {
        return await Promise.race([promise, CancellationScope.current().cancelRequested]);
      } catch (err) {
        if (!(err instanceof CancelledFailure)) {
          throw err;
        }
        console.log('Workflow cancelled while waiting on non cancellable scope');
        return await promise;
      }
    },
  };
}
