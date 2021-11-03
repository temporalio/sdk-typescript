// @@@SNIPSTART typescript-schedule-activity-workflow
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { httpGet } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function http(): Promise<string> {
  return await httpGet('https://temporal.io');
}
// @@@SNIPEND
