/**
 * Tests child workflow timeout from the parent workflow perspective
 * @module
 */

import { Context } from '@temporalio/workflow';
import { workflow as blocked } from './trigger-cancellation';

export async function main(): Promise<void> {
  const child = Context.child<typeof blocked>('trigger-cancellation', {
    taskQueue: 'test',
    workflowExecutionTimeout: '10ms',
    retryPolicy: { maximumAttempts: 1 },
  });
  await child.execute(); // should time out
}
