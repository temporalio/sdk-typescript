import * as workflow from '@temporalio/workflow';

export const unblockEcho = workflow.defineUpdate<void, []>('unblockEcho');

export async function blockingEcho(input: string): Promise<string> {
  let unblocked = false;
  workflow.setHandler(unblockEcho, () => {
    unblocked = true;
  });
  await workflow.condition(() => unblocked);
  return input;
}
