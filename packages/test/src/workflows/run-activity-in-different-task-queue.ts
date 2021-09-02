import { Context } from '@temporalio/workflow';
import type * as activities from '../activities';

export function runActivityInDifferentTaskQueue(taskQueue: string): { execute(): Promise<string> } {
  const { echo } = Context.configureActivities<typeof activities>({
    type: 'remote',
    taskQueue,
    scheduleToCloseTimeout: '30 minutes',
  });

  return {
    execute: () => echo('hi'),
  };
}
