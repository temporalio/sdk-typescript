/**
 * Tests continueAsNew to another Workflow
 * @module
 */
import { makeContinueAsNewFunc } from '@temporalio/workflow';
import { sleeper } from './sleep';

export async function continueAsNewToDifferentWorkflow(ms = 1): Promise<void> {
  const continueAsNew = makeContinueAsNewFunc<typeof sleeper>({ workflowType: 'sleeper' });
  await continueAsNew(ms);
}
