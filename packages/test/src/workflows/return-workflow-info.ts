import { WorkflowInfo, workflowInfo } from '@temporalio/workflow';

export async function returnWorkflowInfo(): Promise<WorkflowInfo> {
  return workflowInfo();
}
