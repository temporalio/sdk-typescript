// @@@SNIPSTART nodejs-non-cancellable-shields-children
import { CancellationScope, configureActivities } from '@temporalio/workflow';
import type * as activities from '../activities';
import { HTTPGetter } from '../interfaces';

const { httpGetJSON } = configureActivities<typeof activities>({ type: 'remote', startToCloseTimeout: '10m' });

export const nonCancellable: HTTPGetter = (url: string) => ({
  async execute() {
    // Prevent Activity from being cancelled and await completion.
    // Note that the Workflow is completely oblivious and impervious to cancellation in this example.
    return CancellationScope.nonCancellable(() => httpGetJSON(url));
  },
});
// @@@SNIPEND
