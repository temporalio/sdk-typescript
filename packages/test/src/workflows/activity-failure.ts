/**
 * Tests that ActivityFailure is propagated correctly to client
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { throwAnError } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5s',
  retry: { initialInterval: '1s', maximumAttempts: 1 },
});

export interface ActivityFailureWorkflowOptions {
  useApplicationFailure: boolean;
}

export async function activityFailure({ useApplicationFailure }: ActivityFailureWorkflowOptions): Promise<void> {
  if (useApplicationFailure) {
    await throwAnError(true, 'Fail me');
  } else {
    await throwAnError(false, 'Fail me');
  }
}
