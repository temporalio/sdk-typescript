import { workflowInfo } from '@temporalio/workflow';

export async function continueAsNewSuggested(): Promise<boolean> {
  return workflowInfo().continueAsNewSuggested;
}
