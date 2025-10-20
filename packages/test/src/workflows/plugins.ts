import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { echo } = proxyActivities<typeof activities>({
  startToCloseTimeout: '20s',
  retry: { initialInterval: 5, maximumAttempts: 1, nonRetryableErrorTypes: ['NonRetryableError'] },
});

export async function helloWorkflow(): Promise<string> {
  return 'Hello';
}

export async function activityWorkflow(): Promise<string> {
  return echo('Hello');
}
