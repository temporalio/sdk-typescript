/**
 * Tests child workflow termination from the parent workflow perspective
 * @module
 */

import { WorkflowExecution } from '@temporalio/common';
import { startChild, defineQuery, setHandler } from '@temporalio/workflow';
import { unblockOrCancel } from './unblock-or-cancel';

export const childExecutionQuery = defineQuery<WorkflowExecution | undefined>('childExecution');

export async function childWorkflowTermination(): Promise<void> {
  let workflowExecution: WorkflowExecution | undefined = undefined;
  setHandler(childExecutionQuery, () => workflowExecution);

  const child = await startChild(unblockOrCancel, {});
  workflowExecution = { workflowId: child.workflowId, runId: child.firstExecutionRunId };
  await child.result();
}
