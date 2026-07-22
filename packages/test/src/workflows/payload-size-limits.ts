/**
 * Workflow used by test-payload-size-limits: optionally schedules an activity with a large input,
 * then returns a string of the requested size. Used to exercise sdk-core's payload size-limit
 * enforcement (proactive task failure / warning logs).
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { echo } = proxyActivities<typeof activities>({
  scheduleToCloseTimeout: '5s',
});

export interface PayloadSizeLimitsInput {
  activityInputDataSize: number;
  workflowOutputDataSize: number;
}

export async function payloadSizeLimitsWorkflow(input: PayloadSizeLimitsInput): Promise<string> {
  if (input.activityInputDataSize > 0) {
    await echo('i'.repeat(input.activityInputDataSize));
  }
  return 'o'.repeat(input.workflowOutputDataSize);
}
