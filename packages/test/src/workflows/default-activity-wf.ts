import { proxyActivities } from '@temporalio/workflow';
import { NameAndArgs } from '../activities/default-and-defined';
import type * as activities from '../activities/default-and-defined';

const { definedActivity, nonExistentActivity } = proxyActivities<
  typeof activities & { nonExistentActivity: (...args: unknown[]) => Promise<NameAndArgs> }
>({
  startToCloseTimeout: '30 seconds',
});

export async function workflowWithMaybeDefinedActivity(
  useDefinedActivity: boolean,
  activityArgs: unknown[]
): Promise<NameAndArgs> {
  if (useDefinedActivity) {
    return await definedActivity(...activityArgs);
  }
  return await nonExistentActivity(...activityArgs);
}
