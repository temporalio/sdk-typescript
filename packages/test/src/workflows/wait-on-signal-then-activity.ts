import * as wf from '@temporalio/workflow';
import type * as activities from '../activities';

const { echo } = wf.proxyActivities<typeof activities>({ startToCloseTimeout: '5s' });
export const mySignal = wf.defineSignal<[string]>('my-signal');
export async function waitOnSignalThenActivity(): Promise<void> {
  let lastSignal = '<none>';

  wf.setHandler(mySignal, (value: string) => {
    lastSignal = value;
  });

  await wf.condition(() => lastSignal === 'finish');
  await echo('hi');
}
