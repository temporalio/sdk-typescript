import { DefaultWorkflowFunction } from '@temporalio/workflow';

export interface WorkflowTypeAndArgs {
  handler: string;
  workflowType?: string;
  args: unknown[];
}

export async function existing(...args: unknown[]): Promise<WorkflowTypeAndArgs> {
  return {
    handler: 'existing',
    args,
  };
}

const defaultWorkflow: DefaultWorkflowFunction = async function (
  workflowType: string,
  ...args: unknown[]
): Promise<WorkflowTypeAndArgs> {
  return {
    handler: 'default',
    workflowType,
    args,
  };
};

export default defaultWorkflow;
