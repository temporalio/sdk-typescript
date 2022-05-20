import { SearchAttributeValue, workflowInfo } from '@temporalio/workflow';

export async function returnSearchAttributes(): Promise<Record<string, SearchAttributeValue> | undefined> {
  return workflowInfo().searchAttributes;
}
