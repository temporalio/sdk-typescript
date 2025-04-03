// @@@SNIPSTART typescript-priority-workflow
import { executeChild, proxyActivities, startChild, workflowInfo } from '@temporalio/workflow';
import { temporal } from '@temporalio/proto';
import type * as activities from '../activities';
import Priority = temporal.api.common.v1.Priority;

const { echo } = proxyActivities<typeof activities>({ startToCloseTimeout: '5s', priority: Priority.create({ priorityKey: 5}) });

export async function priorityWorkflow(stopAfterCheck: boolean, expectedPriority?: number): Promise<void> {
  const info = workflowInfo();
  if (info.priority?.priorityKey !== expectedPriority) {
    console.log("priorityKey", info.priority?.priorityKey)
    console.log("expectedPriority", expectedPriority)
    throw new Error('workflow priority doesn\'t match expected priority');
  }
  if (stopAfterCheck) {
    return;
  }

  await executeChild(priorityWorkflow, {args: [true, 4]});

  const child = await startChild(priorityWorkflow, {args: [true, 2],});
  await child.result();

  await echo("hi")
}
// @@@SNIPEND

