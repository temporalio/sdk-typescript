/**
 * Tests the happy path of starting and awaiting a child workflow
 * @module
 */

import { startChild, executeChild } from '@temporalio/workflow';
import { successString } from './success-string';

export async function childWorkflowInvoke(): Promise<{
  workflowId: string;
  runId: string;
  execResult: string;
  result: string;
}> {
  const child = await startChild(successString, {});
  const execResult = await executeChild(successString, {});
  return { workflowId: child.workflowId, runId: child.originalRunId, result: await child.result(), execResult };
}
