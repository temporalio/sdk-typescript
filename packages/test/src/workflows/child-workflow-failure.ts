/**
 * Tests child workflow failure from the parent workflow perspective
 * @module
 */

import { createChildWorkflowHandle } from '@temporalio/workflow';
import { throwAsync } from './throw-async';

export async function childWorkflowFailure(): Promise<void> {
  const child = createChildWorkflowHandle(throwAsync, {
    taskQueue: 'test',
  });
  await child.execute();
}
