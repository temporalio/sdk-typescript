import * as wf from '@temporalio/workflow';

export const mutateWorkflowStateQuery = wf.defineQuery<void>('mutateWorkflowState');

export async function queryAndCondition(): Promise<void> {
  let mutated = false;
  // Not a valid query, used to verify that condition isn't triggered for query jobs
  wf.setHandler(mutateWorkflowStateQuery, () => void (mutated = true));
  await wf.condition(() => mutated);
}
