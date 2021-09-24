/**
 * Tests child workflow failure from the parent workflow perspective
 * @module
 */

import { createChildWorkflowHandle } from '@temporalio/workflow';
import { Empty } from '../interfaces';
import { throwAsync } from './throw-async';

export const childWorkflowFailure: Empty = () => ({
  async execute(): Promise<void> {
    const child = createChildWorkflowHandle(throwAsync, {
      taskQueue: 'test',
    });
    await child.execute();
  },
});
