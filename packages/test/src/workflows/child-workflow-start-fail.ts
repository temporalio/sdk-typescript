/**
 * Tests child workflow start failures
 * @module
 */

import { Context, WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from '@temporalio/workflow';
import { Empty } from '../interfaces';
import { successString } from './success-string';

export const childWorkflowStartFail: Empty = () => {
  return {
    async execute(): Promise<void> {
      const child = Context.child(successString, {
        taskQueue: 'test',
        workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
      });
      await child.start();
      try {
        await child.start();
        throw new Error('Calling start on child workflow stub twice did not fail');
      } catch (err) {
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
          throw new Error(`Got invalid error: ${err}`);
        }
      }
      await child.result();

      try {
        const duplicate = Context.child(successString, {
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
    },
  };
};
