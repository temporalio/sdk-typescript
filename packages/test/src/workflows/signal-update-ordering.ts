import * as wf from '@temporalio/workflow';

export const fooSignal = wf.defineSignal('fooSignal');
export const fooUpdate = wf.defineUpdate<number>('fooUpdate');

// Repro for https://github.com/temporalio/sdk-typescript/issues/1474
export async function signalUpdateOrderingWorkflow(): Promise<number> {
  let numFoos = 0;
  wf.setHandler(fooSignal, () => {
    numFoos++;
  });
  wf.setHandler(fooUpdate, () => {
    numFoos++;
    return numFoos;
  });
  await wf.condition(() => numFoos > 1);
  return numFoos;
}
