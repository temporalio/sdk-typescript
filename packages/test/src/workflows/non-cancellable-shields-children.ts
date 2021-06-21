// @@@SNIPSTART nodejs-non-cancellable-shields-children
import { CancellationScope } from '@temporalio/workflow';
import { httpGetJSON } from '@activities';

export async function main(url: string): Promise<any> {
  // Prevent Activity from being cancelled and await completion.
  // Note that the Workflow is completely oblivious and impervious to cancellation in this example.
  return CancellationScope.nonCancellable(() => httpGetJSON(url));
}
// @@@SNIPEND
