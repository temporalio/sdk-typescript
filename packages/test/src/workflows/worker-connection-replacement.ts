import { sleep } from '@temporalio/workflow';

export async function tickingWorkflow(): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    await sleep(100);
  }
}
