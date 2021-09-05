// @@@SNIPSTART nodejs-shared-promise-scopes
import { CancellationScope, Context } from '@temporalio/workflow';
import * as activities from '../activities';

const { httpGetJSON } = Context.configureActivities<typeof activities>({ type: 'remote', startToCloseTimeout: '10m' });

export async function main(): Promise<any> {
  // Start activities in the root scope
  const p1 = httpGetJSON('http://url1.ninja');
  const p2 = httpGetJSON('http://url2.ninja');

  const scopePromise = CancellationScope.cancellable(async () => {
    const first = await Promise.race([p1, p2]);
    // Does not cancel activity1 or activity2 as they're linked to the root scope
    CancellationScope.current().cancel();
    return first;
  });
  return await scopePromise;
  // The Activity that did not complete will effectively be cancelled when
  // Workflow completes unless the Activity is awaited:
  // await Promise.all([p1, p2]);
}
// @@@SNIPEND
