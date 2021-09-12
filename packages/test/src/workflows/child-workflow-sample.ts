// @@@SNIPSTART nodejs-child-workflow
import { newChildWorkflowStub } from '@temporalio/workflow';
// successString is a workflow implementation like childWorkflowExample below.
// It is called with no arguments and return the string "success".
import { successString } from './success-string';

export interface ChildWorkflowExample {
  execute(): Promise<string>;
}

export function childWorkflowExample(): ChildWorkflowExample {
  return {
    async execute() {
      const child = newChildWorkflowStub(successString);
      return await child.execute();
    },
  };
}
// @@@SNIPEND
