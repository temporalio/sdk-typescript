// @@@SNIPSTART nodejs-schedule-activity-workflow
import { Context } from '@temporalio/workflow';
import * as activities from '../activities';
import { HTTP } from '../interfaces';

const { httpGet } = Context.configureActivities<typeof activities>({
  type: 'remote',
  startToCloseTimeout: '1 minute',
});

async function main(): Promise<string> {
  return await httpGet('https://temporal.io');
}

export const workflow: HTTP = { main };
// @@@SNIPEND
