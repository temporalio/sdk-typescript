/**
 * Tests child workflow termination from the parent workflow perspective
 * @module
 */

import { WorkflowExecution } from '@temporalio/common';
import { childWorkflow } from '@temporalio/workflow';
import { ChildTerminator } from '../interfaces';
import { unblockOrCancel } from './unblock-or-cancel';

export const childWorkflowTermination: ChildTerminator = () => {
  let workflowExecution: WorkflowExecution | undefined = undefined;

  return {
    queries: {
      childExecution(): WorkflowExecution | undefined {
        return workflowExecution;
      },
    },
    async execute(): Promise<void> {
      const child = childWorkflow(unblockOrCancel, {
        taskQueue: 'test',
      });
      workflowExecution = { workflowId: child.workflowId, runId: await child.start() };
      await child.result();
    },
  };
};
