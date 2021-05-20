import { Context } from '@temporalio/workflow';
import { throwAnError } from '@activities';

const runActivity = Context.configure(throwAnError, {
  type: 'remote',
  startToCloseTimeout: '5s',
  retry: { initialInterval: '1s', maximumAttempts: 1 },
});

export async function main(): Promise<void> {
  await runActivity('Fail me');
}
