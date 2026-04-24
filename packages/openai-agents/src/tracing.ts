import { inWorkflowContext, workflowInfo } from '@temporalio/workflow';

export function isInWorkflow(): boolean {
  return inWorkflowContext();
}

export function isReplaying(): boolean {
  if (!inWorkflowContext()) return false;
  return workflowInfo().unsafe.isReplaying;
}

export function getWorkflowTracingConfig(): 'disabled' | 'enabled' {
  return inWorkflowContext() ? 'disabled' : 'enabled';
}
