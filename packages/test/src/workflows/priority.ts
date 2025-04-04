// @@@SNIPSTART typescript-priority-workflow
import { executeChild, proxyActivities, startChild, workflowInfo } from '@temporalio/workflow';
import { temporal } from '@temporalio/proto';
import { Priority } from '@temporalio/common';
import type * as activities from '../activities';


const { echo } = proxyActivities<typeof activities>({ startToCloseTimeout: '5s', priority: new Priority(5) });

export async function priorityWorkflow(stopAfterCheck: boolean, expectedPriority?: number): Promise<void> {
  const info = workflowInfo();
  console.log("info.priority", info.priority)
  console.log("priorityKey", info.priority?.priorityKey)
  console.log("expectedPriority", expectedPriority)
  if (info.priority?.priorityKey !== expectedPriority) {
    throw new Error('workflow priority doesn\'t match expected priority');
  }
  if (stopAfterCheck) {
    return;
  }

  await executeChild(priorityWorkflow, {args: [true, 4]});

  const child = await startChild(priorityWorkflow, {args: [true, 2],});
  await child.result();

  await echo("hi")
  return;
}
// @@@SNIPEND

