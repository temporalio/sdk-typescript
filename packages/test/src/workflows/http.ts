// @@@SNIPSTART nodejs-schedule-activity-workflow
import { configureActivities } from '@temporalio/workflow';
import type * as activities from '../activities';
import { HTTP } from '../interfaces';

const { httpGet } = configureActivities<typeof activities>({
  type: 'remote',
  startToCloseTimeout: '1 minute',
});

async function execute(): Promise<string> {
  return await httpGet('https://temporal.io');
}

export const http: HTTP = () => ({ execute });
// @@@SNIPEND
