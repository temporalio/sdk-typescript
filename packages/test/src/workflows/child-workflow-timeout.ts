/**
 * Tests child workflow timeout from the parent workflow perspective
 * @module
 */

import { createChildWorkflowHandle } from '@temporalio/workflow';
import { unblockOrCancel } from './unblock-or-cancel';

export async function childWorkflowTimeout(): Promise<void> {
  const child = createChildWorkflowHandle(unblockOrCancel, {
    workflowExecutionTimeout: '10ms',
    retryPolicy: { maximumAttempts: 1 },
  });
  await child.execute(); // should time out
}
