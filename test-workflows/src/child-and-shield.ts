import { CancellationError, cancellationScope, shield, sleep, cancel } from '@temporal-sdk/workflow';

export async function main() {
  const child = cancellationScope(async () => {
    await shield(async () => {
      await sleep(5);
      console.log('Slept in shield 👍');
    });
  });
  cancel(child);
  try {
    await child;
    console.log('Exception was not propagated 👎');
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Exception was propagated 👍');
    }
  }
  await sleep(6); // wait for the shielded sleep to fire
}
