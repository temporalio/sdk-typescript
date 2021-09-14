import { createActivityHandle } from '@temporalio/workflow';
import type * as activities from '../activities';

export function runActivityInDifferentTaskQueue(taskQueue: string): { execute(): Promise<string> } {
  const { echo } = createActivityHandle<typeof activities>({
    taskQueue,
    scheduleToCloseTimeout: '30 minutes',
  });

  return {
    execute: () => echo('hi'),
  };
}
