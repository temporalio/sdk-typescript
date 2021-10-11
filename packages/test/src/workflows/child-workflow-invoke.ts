/**
 * Tests the happy path of starting and awaiting a child workflow
 * @module
 */

import { createChildWorkflowHandle } from '@temporalio/workflow';
import { successString } from './success-string';

export async function childWorkflowInvoke(): Promise<{
  workflowId: string;
  runId: string;
  execResult: string;
  result: string;
}> {
  const child = createChildWorkflowHandle(successString);
  const execResult = await createChildWorkflowHandle(successString).execute();
  return { workflowId: child.workflowId, runId: await child.start(), result: await child.result(), execResult };
}
