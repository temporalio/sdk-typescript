/**
 * Tests continueAsNew to another Workflow
 * @module
 */
import { makeContinueAsNewFunc } from '@temporalio/workflow';
import { sleeper } from './sleep';

export async function continueAsNewToDifferentWorkflow(): Promise<void> {
  const continueAsNew = makeContinueAsNewFunc<typeof sleeper>({ workflowType: 'sleeper' });
  await continueAsNew(1);
}
