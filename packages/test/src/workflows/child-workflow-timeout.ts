/**
 * Tests child workflow timeout from the parent workflow perspective
 * @module
 */

import { executeChild } from '@temporalio/workflow';
import { unblockOrCancel } from './unblock-or-cancel';

export async function childWorkflowTimeout(): Promise<void> {
  await executeChild(unblockOrCancel, {
    workflowExecutionTimeout: '10ms',
    retryPolicy: { maximumAttempts: 1 },
  });
}
