/**
 * Tests continueAsNew to another Workflow
 * @module
 */
import { makeContinueAsNewFunc } from '@temporalio/workflow';
import { Empty, Sleeper } from '../interfaces';

export const continueAsNewToDifferentWorkflow: Empty = () => ({
  async execute(): Promise<void> {
    const continueAsNew = makeContinueAsNewFunc<Sleeper>({ workflowType: 'sleeper' });
    await continueAsNew(1);
  },
});
