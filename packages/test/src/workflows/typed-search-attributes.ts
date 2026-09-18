import type { SearchAttributes, SearchAttributeUpdatePair } from '@temporalio/common';
import type { WorkflowInfo } from '@temporalio/workflow';
import {
  condition,
  defineQuery,
  defineSignal,
  setHandler,
  upsertSearchAttributes,
  workflowInfo,
} from '@temporalio/workflow';

export const getWorkflowInfo = defineQuery<WorkflowInfo>('getWorkflowInfo');
export const mutateSearchAttributes =
  defineSignal<[SearchAttributes | SearchAttributeUpdatePair[]]>('mutateSearchAttributes');
export const complete = defineSignal('complete');

export async function changeSearchAttributes(): Promise<void> {
  let isComplete = false;
  setHandler(getWorkflowInfo, workflowInfo);
  setHandler(complete, () => {
    isComplete = true;
  });
  setHandler(mutateSearchAttributes, upsertSearchAttributes);
  await condition(() => isComplete);
}
