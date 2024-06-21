/**
 * Tests child workflow start failures
 * @module
 */

import { startChild, WorkflowIdReusePolicy } from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { successString } from './success-string';

export async function childWorkflowStartFail(): Promise<void> {
  const child = await startChild(successString, {
    taskQueue: 'test',
    workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
  });
  await child.result();

  try {
    await startChild(successString, {
      taskQueue: 'test',
      workflowId: child.workflowId, // duplicate
      workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
    });
    throw new Error('Managed to start a Workflow with duplicate workflowId');
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
      throw new Error(`Got invalid error: ${err}`);
    }
  }
}
