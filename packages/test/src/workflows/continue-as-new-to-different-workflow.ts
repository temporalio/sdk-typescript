/**
 * Tests continueAsNew to another Workflow
 * @module
 */
import type { ContinueAsNewOptions } from '@temporalio/workflow';
import { makeContinueAsNewFunc } from '@temporalio/workflow';
import type { sleeper } from './sleep';

export async function continueAsNewToDifferentWorkflow(
  ms = 1,
  extraArgs?: Partial<ContinueAsNewOptions>
): Promise<void> {
  const continueAsNew = makeContinueAsNewFunc<typeof sleeper>({ workflowType: 'sleeper', ...(extraArgs ?? {}) });
  await continueAsNew(ms);
}
