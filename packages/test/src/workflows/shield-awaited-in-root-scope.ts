// @@@SNIPSTART typescript-shield-awaited-in-root-scope
import { CancellationScope, createActivityHandle } from '@temporalio/workflow';
import type * as activities from '../activities';

const { httpGetJSON } = createActivityHandle<typeof activities>({ startToCloseTimeout: '10m' });

export async function shieldAwaitedInRootScope(): Promise<any> {
  let p: Promise<any> | undefined = undefined;

  await CancellationScope.nonCancellable(async () => {
    p = httpGetJSON('http://example.com'); // <-- Start activity in nonCancellable scope without awaiting completion
  });
  // Activity is shielded from cancellation even though it is awaited in the cancellable root scope
  return p;
}
// @@@SNIPEND
