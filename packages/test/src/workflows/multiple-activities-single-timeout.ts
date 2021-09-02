// @@@SNIPSTART nodejs-multiple-activities-single-timeout-workflow
import { CancellationScope, Context } from '@temporalio/workflow';
import type * as activities from '../activities';

const { httpGetJSON } = Context.configureActivities<typeof activities>({ type: 'remote', startToCloseTimeout: '10m' });

export interface MultiHTTPHandler {
  execute(): Promise<any[]>;
}

export function multipleActivitiesSingleTimeout(urls: string[], timeoutMs: number): MultiHTTPHandler {
  return {
    async execute() {
      // If timeout triggers before all activities complete
      // the Workflow will fail with a CancelledError.
      return CancellationScope.withTimeout(timeoutMs, () => Promise.all(urls.map((url) => httpGetJSON(url))));
    },
  };
}
// @@@SNIPEND
