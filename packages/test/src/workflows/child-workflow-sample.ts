import { executeChild } from '@temporalio/workflow';
// successString is a workflow implementation like childWorkflowExample below.
// It is called with no arguments and return the string "success".
import { successString } from './success-string';

export async function childWorkflowExample(): Promise<string> {
  return await executeChild(successString, { args: [] });
}
