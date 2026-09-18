import * as workflow from '@temporalio/workflow';

export class CustomWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomWorkflowError';
  }
}

export class CustomWorkflowSubError extends CustomWorkflowError {
  constructor(message: string) {
    super(message);
    this.name = 'CustomWorkflowSubError';
  }
}

export async function throwCustomError(): Promise<void> {
  throw new CustomWorkflowError('custom error');
}
export async function throwCustomSubError(): Promise<void> {
  throw new CustomWorkflowSubError('custom sub error');
}
export async function throwPlainError(): Promise<void> {
  throw new Error('plain error');
}
export async function throwCustomErrorWithDefinitionOptions(): Promise<void> {
  throw new CustomWorkflowError('custom error from definition options');
}
workflow.setWorkflowOptions({ failureExceptionTypes: [CustomWorkflowError] }, throwCustomErrorWithDefinitionOptions);
export async function throwSubErrorWithParentInDefinitionOptions(): Promise<void> {
  throw new CustomWorkflowSubError('sub error with parent in definition options');
}
workflow.setWorkflowOptions(
  { failureExceptionTypes: [CustomWorkflowError] },
  throwSubErrorWithParentInDefinitionOptions
);
export async function nondeterministicWorkflow(): Promise<void> {
  if (!workflow.workflowInfo().unsafe.isReplaying) await workflow.sleep('1ms');
}
