// @@@SNIPSTART nodejs-multiple-activities-single-timeout-workflow
import { CancellationScope, createActivityHandle } from '@temporalio/workflow';
import type * as activities from '../activities';

export interface MultiHTTPHandler {
  execute(): Promise<any[]>;
}

export function multipleActivitiesSingleTimeout(urls: string[], timeoutMs: number): MultiHTTPHandler {
  const { httpGetJSON } = createActivityHandle<typeof activities>({
    startToCloseTimeout: timeoutMs,
  });

  return {
    async execute() {
      // If timeout triggers before all activities complete
      // the Workflow will fail with a CancelledError.
      return CancellationScope.withTimeout(timeoutMs, () => Promise.all(urls.map((url) => httpGetJSON(url))));
    },
  };
}
// @@@SNIPEND
