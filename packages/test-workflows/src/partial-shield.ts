import { CancellationError, shield, sleep } from '@temporalio/workflow';

export async function main(): Promise<void> {
  try {
    await Promise.all([
      shield(async () => {
        await sleep(5);
        await sleep(1);
      }),
      (async () => {
        await sleep(3);
        await sleep(2);
      })(),
    ]);
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Workflow cancelled');
    }
    // Let the shielded sleep be triggered before completion
    await sleep(10);
  }
}
