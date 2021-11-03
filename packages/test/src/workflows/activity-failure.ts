/**
 * Tests that ActivityFailure is propagated correctly to client
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { throwAnError } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5s',
  retry: { initialInterval: '1s', maximumAttempts: 1 },
});

export async function activityFailure(): Promise<void> {
  await throwAnError('Fail me');
}
