// @@@SNIPSTART nodejs-shield-awaited-in-root-scope
import { CancellationScope, configureActivities } from '@temporalio/workflow';
import { Returner } from '../interfaces';
import type * as activities from '../activities';

const { httpGetJSON } = configureActivities<typeof activities>({ type: 'remote', startToCloseTimeout: '10m' });

export const shieldAwaitedInRootScope: Returner<any> = () => ({
  async execute(): Promise<any> {
    let p: Promise<any> | undefined = undefined;

    await CancellationScope.nonCancellable(async () => {
      p = httpGetJSON('http://example.com'); // <-- Start activity in nonCancellable scope without awaiting completion
    });
    // Activity is shielded from cancellation even though it is awaited in the cancellable root scope
    return p;
  },
});
// @@@SNIPEND
