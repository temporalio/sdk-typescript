import { SearchAttributeValue, upsertSearchAttributes, workflowInfo } from '@temporalio/workflow';

export async function clearSearchAttribute(): Promise<Record<string, SearchAttributeValue[]> | undefined> {
  upsertSearchAttributes({
    CustomIntField: [123],
  });
  upsertSearchAttributes({
    CustomIntField: [],
  });
  return workflowInfo().searchAttributes;
}
