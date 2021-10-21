import { createChildWorkflowHandle } from '@temporalio/workflow';
// successString is a workflow implementation like childWorkflowExample below.
// It is called with no arguments and return the string "success".
import { successString } from './success-string';

export async function childWorkflowExample(): Promise<string> {
  const child = createChildWorkflowHandle(successString);
  return await child.execute();
}
