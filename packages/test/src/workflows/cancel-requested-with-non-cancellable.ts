/**
 * Demonstrates how to make Workflow aware of cancellation while waiting on nonCancellable scope.
 * Used in the documentation site.
 */
// @@@SNIPSTART nodejs-cancel-requested-with-non-cancellable
import { CancelledFailure, CancellationScope } from '@temporalio/workflow';
import { httpGetJSON } from '@activities';

export async function main(url: string): Promise<any> {
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
