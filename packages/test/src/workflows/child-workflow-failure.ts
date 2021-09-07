/**
 * Tests child workflow failure from the parent workflow perspective
 * @module
 */

import { childWorkflow } from '@temporalio/workflow';
import { Empty } from '../interfaces';
import { throwAsync } from './throw-async';

export const childWorkflowFailure: Empty = () => ({
  async execute(): Promise<void> {
    const child = childWorkflow(throwAsync, {
      taskQueue: 'test',
    });
    await child.execute();
  },
});
