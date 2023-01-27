import { workflowInfo } from '@temporalio/workflow';

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

export default async function (...args: unknown[]): Promise<WorkflowTypeAndArgs> {
  return {
    handler: 'default',
    workflowType: workflowInfo().workflowType,
    args,
  };
}
