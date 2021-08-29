/**
 * Tests that ActivityFailure is propagated correctly to client
 */
import { Context } from '@temporalio/workflow';
import * as activities from '../activities';

const { throwAnError } = Context.configureActivities<typeof activities>({
  type: 'remote',
  startToCloseTimeout: '5s',
  retry: { initialInterval: '1s', maximumAttempts: 1 },
});

export async function main(): Promise<void> {
  await throwAnError('Fail me');
}
