/**
 * Tests child workflow start failures
 * @module
 */

import {
  createChildWorkflowHandle,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from '@temporalio/workflow';
import { successString } from './success-string';

export async function childWorkflowStartFail(): Promise<void> {
  const child = createChildWorkflowHandle(successString, {
    taskQueue: 'test',
    workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
  });
  await child.start();
  try {
    await child.start();
    throw new Error('Calling start on child workflow handle twice did not fail');
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
      throw new Error(`Got invalid error: ${err}`);
    }
  }
  await child.result();

  try {
    const duplicate = createChildWorkflowHandle(successString, {
      taskQueue: 'test',
      workflowId: child.workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
    });
    await duplicate.start();
    throw new Error('Managed to start a Workflow with duplicate workflowId');
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
      throw new Error(`Got invalid error: ${err}`);
    }
  }
}
