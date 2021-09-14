// @@@SNIPSTART nodejs-child-workflow
import { createChildWorkflowHandle } from '@temporalio/workflow';
// successString is a workflow implementation like childWorkflowExample below.
// It is called with no arguments and return the string "success".
import { successString } from './success-string';

export interface ChildWorkflowExample {
  execute(): Promise<string>;
}

export function childWorkflowExample(): ChildWorkflowExample {
  return {
    async execute() {
      const child = createChildWorkflowHandle(successString);
      return await child.execute();
    },
  };
}
// @@@SNIPEND
