import { executeChild, proxyActivities, startChild, workflowInfo } from '@temporalio/workflow';
import type * as activities from '../activities';

const { echo } = proxyActivities<typeof activities>({ startToCloseTimeout: '5s', priority: { priorityKey: 5 } });

export async function priorityWorkflow(stopAfterCheck: boolean, expectedPriority: number | undefined): Promise<void> {
  const info = workflowInfo();
  if (!info.priority) {
    throw new Error(`undefined priority`);
  }
  if (info.priority?.priorityKey !== expectedPriority) {
    throw new Error(
      `workflow priority ${info.priority?.priorityKey} doesn't match expected priority ${expectedPriority}`
    );
  }
  if (stopAfterCheck) {
    return;
  }

  await executeChild(priorityWorkflow, { args: [true, 4], priority: { priorityKey: 4 } });

  const child = await startChild(priorityWorkflow, { args: [true, 2], priority: { priorityKey: 2 } });
  await child.result();

  await echo('hi');
}
