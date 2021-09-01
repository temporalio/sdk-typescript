// @@@SNIPSTART nodejs-shield-awaited-in-root-scope
import { Context, CancellationScope } from '@temporalio/workflow';
import * as activities from '../activities';

const { httpGetJSON } = Context.configureActivities<typeof activities>({ type: 'remote', startToCloseTimeout: '10m' });

export async function execute(): Promise<any> {
  let p: Promise<any> | undefined = undefined;

  await CancellationScope.nonCancellable(async () => {
    p = httpGetJSON('http://example.com'); // <-- Start activity in nonCancellable scope without awaiting completion
  });
  // Activity is shielded from cancellation even though it is awaited in the cancellable root scope
  return p;
}
// @@@SNIPEND
