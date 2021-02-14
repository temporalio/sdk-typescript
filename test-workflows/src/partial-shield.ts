import { Context, CancellationError, sleep } from '@temporal-sdk/workflow';

export async function main() {
  try {
    await Promise.all([
      Context.shield(async () => { await sleep(5); await sleep(1); }),
      (async () => { await sleep(3); await sleep(2); })(),
    ]);
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Workflow cancelled');
    }
    // Let the shielded sleep be triggered before completion
    await sleep(10);
  }
}
