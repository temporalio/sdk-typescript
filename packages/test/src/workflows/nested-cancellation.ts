// @@@SNIPSTART typescript-nested-cancellation-scopes
import { CancellationScope, createActivityHandle, isCancellation } from '@temporalio/workflow';

import type * as activities from '../activities';

const { setup, httpPostJSON, cleanup } = createActivityHandle<typeof activities>({
  startToCloseTimeout: '10m',
});

export async function nestedCancellation(url: string): Promise<void> {
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
