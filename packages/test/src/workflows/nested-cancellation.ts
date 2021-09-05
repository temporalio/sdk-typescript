// @@@SNIPSTART nodejs-nested-cancellation-scopes
import { CancellationScope, Context, isCancellation } from '@temporalio/workflow';

import * as activities from '../activities';

const { setup, httpPostJSON, cleanup } = Context.configureActivities<typeof activities>({
  type: 'remote',
  startToCloseTimeout: '10m',
});

export async function main(url: string): Promise<void> {
  await CancellationScope.cancellable(async () => {
    await CancellationScope.nonCancellable(() => setup());
    try {
      await CancellationScope.withTimeout(1000, () => httpPostJSON(url, { some: 'data' }));
    } catch (err) {
      if (isCancellation(err)) {
        await CancellationScope.nonCancellable(() => cleanup(url));
      }
      throw err;
    }
  });
}
// @@@SNIPEND
