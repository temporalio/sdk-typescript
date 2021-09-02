/**
 * Tests child workflow failure from the parent workflow perspective
 * @module
 */

import { Context } from '@temporalio/workflow';
import { Empty } from '../interfaces';
import { throwAsync } from './throw-async';

export const childWorkflowFailure: Empty = () => ({
  async execute(): Promise<void> {
    const child = Context.child(throwAsync, {
      taskQueue: 'test',
    });
    await child.execute();
  },
});
