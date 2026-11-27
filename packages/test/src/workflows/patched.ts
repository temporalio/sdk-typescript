import { patched, sleep } from '@temporalio/workflow';

export async function patchedWorkflow(): Promise<void> {
  if (patched('my-change-id')) {
    console.log('has change');
  } else {
    console.log('no change');
  }
  await sleep(100);
  if (patched('my-change-id')) {
    console.log('has change 2');
  } else {
    console.log('no change 2');
  }
}

/** Like `patchedWorkflow`, but each decision shows up as the duration of the timer it starts. */
export async function patchedTimerWorkflow(): Promise<void> {
  await sleep(patched('my-change-id') ? 100 : 101);
  await sleep(patched('my-change-id') ? 200 : 201);
}
