import { Context } from '@temporalio/workflow';
import * as activities from '@activities';

export async function main(taskQueue: string): Promise<string> {
  const echo = Context.configure(activities.echo, {
    type: 'remote',
    taskQueue,
    scheduleToCloseTimeout: '30 minutes',
  });

  return await echo('hi');
}
