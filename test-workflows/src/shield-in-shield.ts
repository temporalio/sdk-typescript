import { Context, CancellationError, sleep } from '@temporal-sdk/workflow';

export async function main() {
  try {
    await Context.shield(async () => {
      const timer = sleep(2);
      const child = Context.shield(async () => {
        await sleep(1);
        console.log('Timer 1 finished 👍');
      });
      Context.cancel(child);
      try {
        await child;
        console.log('Exception was not propagated 👎');
      } catch (e) {
        if (e instanceof CancellationError) {
          console.log('Exception was propagated 👍');
        }
        await timer;
        console.log('Timer 0 finished 👍');
        throw e;
      }
    });
    console.log('Exception was not propagated 👎');
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Exception was propagated 👍');
    }
  }
}
