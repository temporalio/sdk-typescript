import { createActivityHandle } from '@temporalio/workflow';
import type * as activities from '../activities';

export async function runActivityInDifferentTaskQueue(taskQueue: string): Promise<string> {
  const { echo } = createActivityHandle<typeof activities>({
    taskQueue,
    scheduleToCloseTimeout: '30 minutes',
  });

  return await echo('hi');
}
