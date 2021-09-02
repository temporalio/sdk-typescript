/**
 * Tests continueAsNew to another Workflow
 * @module
 */
import { Context } from '@temporalio/workflow';
import { Empty, Sleeper } from '../interfaces';

export const continueAsNewToDifferentWorkflow: Empty = () => ({
  async execute(): Promise<void> {
    const continueAsNew = Context.makeContinueAsNewFunc<Sleeper>({ workflowType: 'sleeper' });
    await continueAsNew(1);
  },
});
