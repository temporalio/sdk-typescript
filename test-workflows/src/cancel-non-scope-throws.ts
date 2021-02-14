import { Context, sleep } from '@temporal-sdk/workflow';

export async function main() {
  {
    const promise = Promise.resolve();
    try {
      Context.cancel(promise);
    } catch (e) {
      console.log(e.message);
    }
  }
  await Context.scope(async () => {
    const promise = (async () => {
      await sleep(3);
    })();
    try {
      Context.cancel(promise);
    } catch (e) {
      console.log(e.message);
    }
  });
}
