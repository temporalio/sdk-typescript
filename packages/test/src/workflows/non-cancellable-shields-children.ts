// @@@SNIPSTART nodejs-non-cancellable-shields-children
import { CancellationScope, Context } from '@temporalio/workflow';
import * as activities from '../activities';

const { httpGetJSON } = Context.configureActivities<typeof activities>({ type: 'remote', startToCloseTimeout: '10m' });

export async function execute(url: string): Promise<any> {
  // Prevent Activity from being cancelled and await completion.
  // Note that the Workflow is completely oblivious and impervious to cancellation in this example.
  return CancellationScope.nonCancellable(() => httpGetJSON(url));
}
// @@@SNIPEND
