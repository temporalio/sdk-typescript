import { Context, CancellationError, sleep } from '@temporal-sdk/workflow';

export async function main() {
  const child = Context.scope(async () => {
    await Context.shield(async () => {
      await sleep(5);
      console.log('Slept in shield 👍');
    });
  });
  Context.cancel(child);
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
