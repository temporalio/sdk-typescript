/**
 * Tests child workflow termination from the parent workflow perspective
 * @module
 */

import { WorkflowExecution } from '@temporalio/common';
import { createChildWorkflowHandle, defineQuery, setListener } from '@temporalio/workflow';
import { unblockOrCancel } from './unblock-or-cancel';

export const childExecutionQuery = defineQuery<WorkflowExecution | undefined>('childExecution');

export async function childWorkflowTermination(): Promise<void> {
  let workflowExecution: WorkflowExecution | undefined = undefined;
  setListener(childExecutionQuery, () => workflowExecution);

  const child = createChildWorkflowHandle(unblockOrCancel, {
    taskQueue: 'test',
  });
  workflowExecution = { workflowId: child.workflowId, runId: await child.start() };
  await child.result();
}
