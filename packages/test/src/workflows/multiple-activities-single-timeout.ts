// @@@SNIPSTART nodejs-multiple-activities-single-timeout-workflow
import { CancellationScope } from '@temporalio/workflow';
import { httpGetJSON } from '@activities';

export async function main(urls: string[], timeoutMs: number): Promise<any[]> {
  // If timeout triggers before all activities complete
  // the Workflow will fail with a CancellationError.
  return CancellationScope.withTimeout(timeoutMs, () => Promise.all(urls.map((url) => httpGetJSON(url))));
}
// @@@SNIPEND
