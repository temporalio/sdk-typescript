// @@@SNIPSTART nodejs-nested-cancellation-scopes
import { CancellationScope, createActivityHandle, isCancellation } from '@temporalio/workflow';

import type * as activities from '../activities';
import { HTTPPoster } from '../interfaces';

const { setup, httpPostJSON, cleanup } = createActivityHandle<typeof activities>({
  type: 'remote',
  startToCloseTimeout: '10m',
});

export const nestedCancellation: HTTPPoster = (url: string) => ({
  async execute(): Promise<void> {
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
  },
});
// @@@SNIPEND
