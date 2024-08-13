import * as wf from '@temporalio/workflow';

export async function canCompleteUpdateAfterWorkflowReturns(): Promise<void> {
  let gotUpdate = false;
  let mainReturned = false;

  wf.setHandler(wf.defineUpdate<string>('doneUpdate'), async () => {
    gotUpdate = true;
    await wf.condition(() => mainReturned);
    return 'completed';
  });

  await wf.condition(() => gotUpdate);
  mainReturned = true;
}
