// @@@SNIPSTART nodejs-schedule-activity-workflow
import { createActivityHandle } from '@temporalio/workflow';
import type * as activities from '../activities';

const { httpGet } = createActivityHandle<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function http(): Promise<string> {
  return await httpGet('https://temporal.io');
}
// @@@SNIPEND
