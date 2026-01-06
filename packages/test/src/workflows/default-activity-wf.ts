import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/default-and-defined';

const { definedActivity, nonExistentActivity } = proxyActivities<
  typeof activities & { nonExistentActivity: (...args: unknown[]) => Promise<activities.NameAndArgs> }
>({
  startToCloseTimeout: '30 seconds',
});

export async function workflowWithMaybeDefinedActivity(
  useDefinedActivity: boolean,
  activityArgs: unknown[]
): Promise<activities.NameAndArgs> {
  if (useDefinedActivity) {
    return await definedActivity(...activityArgs);
  }
  return await nonExistentActivity(...activityArgs);
}
