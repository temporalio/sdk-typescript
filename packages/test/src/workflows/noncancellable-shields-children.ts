// @@@SNIPSTART typescript-noncancellable-shields-children
import { CancellationScope, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { httpGetJSON } = proxyActivities<typeof activities>({ startToCloseTimeout: '10m' });

export async function nonCancellable(url: string): Promise<any> {
  // Prevent Activity from being cancelled and await completion.
  // Note that the Workflow is completely oblivious and impervious to cancellation in this example.
  return CancellationScope.nonCancellable(() => httpGetJSON(url));
}
// @@@SNIPEND
