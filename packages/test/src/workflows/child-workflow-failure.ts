/**
 * Tests child workflow failure from the parent workflow perspective
 * @module
 */

import { executeChild } from '@temporalio/workflow';
import { throwAsync } from './throw-async';

export async function childWorkflowFailure(): Promise<void> {
  await executeChild(throwAsync, {
    taskQueue: 'test',
  });
}
