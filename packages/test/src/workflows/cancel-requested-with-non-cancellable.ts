/**
 * Demonstrates how to make Workflow aware of cancellation while waiting on nonCancellable scope.
 * Used in the documentation site.
 */
// @@@SNIPSTART typescript-cancel-requested-with-non-cancellable
import { CancelledFailure, CancellationScope, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { httpGetJSON } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10m',
});

export async function resumeAfterCancellation(url: string): Promise<any> {
  let result: any = undefined;
  const scope = new CancellationScope({ cancellable: false });
  const promise = scope.run(() => httpGetJSON(url));
  try {
    result = await Promise.race([scope.cancelRequested, promise]);
  } catch (err) {
    if (!(err instanceof CancelledFailure)) {
      throw err;
    }
    // Prevent Workflow from completing so Activity can complete
    result = await promise;
  }
  return result;
}
// @@@SNIPEND
