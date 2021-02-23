import { cancel, cancellationScope, sleep } from '@temporal-sdk/workflow';

export async function main() {
  {
    const promise = Promise.resolve();
    try {
      cancel(promise);
    } catch (e) {
      console.log(e.message);
    }
  }
  await cancellationScope(async () => {
    const promise = (async () => {
      await sleep(3);
    })();
    try {
      cancel(promise);
    } catch (e) {
      console.log(e.message);
    }
  });
}
