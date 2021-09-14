// @@@SNIPSTART nodejs-schedule-activity-workflow
import { createActivityHandle } from '@temporalio/workflow';
import type * as activities from '../activities';
import { HTTP } from '../interfaces';

const { httpGet } = createActivityHandle<typeof activities>({
  type: 'remote',
  startToCloseTimeout: '1 minute',
});

async function execute(): Promise<string> {
  return await httpGet('https://temporal.io');
}

export const http: HTTP = () => ({ execute });
// @@@SNIPEND
