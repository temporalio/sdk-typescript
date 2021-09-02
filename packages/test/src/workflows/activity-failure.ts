/**
 * Tests that ActivityFailure is propagated correctly to client
 */
import { Context } from '@temporalio/workflow';
import type * as activities from '../activities';
import { Empty } from '../interfaces';

const { throwAnError } = Context.configureActivities<typeof activities>({
  type: 'remote',
  startToCloseTimeout: '5s',
  retry: { initialInterval: '1s', maximumAttempts: 1 },
});

export const activityFailure: Empty = () => ({
  async execute() {
    await throwAnError('Fail me');
  },
});
