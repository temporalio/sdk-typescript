import { patched, sleep } from '@temporalio/workflow';
import { Empty } from '../interfaces';

async function execute(): Promise<void> {
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

export const patchedWorkflow: Empty = () => ({ execute });
