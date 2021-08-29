/**
 * Tests child workflow termination from the parent workflow perspective
 * @module
 */

import { WorkflowExecution } from '@temporalio/common';
import { Context } from '@temporalio/workflow';
import { workflow as blocked } from './unblock-or-cancel';

let workflowExecution: WorkflowExecution | undefined = undefined;

export const queries = {
  childExecution(): WorkflowExecution | undefined {
    return workflowExecution;
  },
};

export async function main(): Promise<void> {
  const child = Context.child<typeof blocked>('unblock-or-cancel', {
    taskQueue: 'test',
  });
  workflowExecution = { workflowId: child.workflowId, runId: await child.start() };
  await child.result();
}
