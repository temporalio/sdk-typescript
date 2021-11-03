// @@@SNIPSTART typescript-multiple-activities-single-timeout-workflow
import { CancellationScope, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

export function multipleActivitiesSingleTimeout(urls: string[], timeoutMs: number): Promise<any> {
  const { httpGetJSON } = proxyActivities<typeof activities>({
    startToCloseTimeout: timeoutMs,
  });

  // If timeout triggers before all activities complete
  // the Workflow will fail with a CancelledError.
  return CancellationScope.withTimeout(timeoutMs, () => Promise.all(urls.map((url) => httpGetJSON(url))));
}
// @@@SNIPEND
