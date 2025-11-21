// @@@SNIPSTART typescript-noncancellable-awaited-in-root-scope
import { CancellationScope, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { httpGetJSON } = proxyActivities<typeof activities>({ startToCloseTimeout: '10m' });

export async function nonCancellableAwaitedInRootScope(): Promise<any> {
  let p: Promise<any> | undefined = undefined;

  await CancellationScope.nonCancellable(async () => {
    p = httpGetJSON('http://example.com'); // <-- Start activity in nonCancellable scope without awaiting completion
  });
  // Activity is shielded from cancellation even though it is awaited in the cancellable root scope
  return p;
}
// @@@SNIPEND
