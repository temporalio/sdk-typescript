// @@@SNIPSTART nodejs-multiple-activities-single-timeout-workflow
import { CancellationScope, Context } from '@temporalio/workflow';
import * as activities from '../activities';

const { httpGetJSON } = Context.configureActivities<typeof activities>({ type: 'remote', startToCloseTimeout: '10m' });

export async function execute(urls: string[], timeoutMs: number): Promise<any[]> {
  // If timeout triggers before all activities complete
  // the Workflow will fail with a CancelledError.
  return CancellationScope.withTimeout(timeoutMs, () => Promise.all(urls.map((url) => httpGetJSON(url))));
}
// @@@SNIPEND
