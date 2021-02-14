import { Context, sleep } from '@temporal-sdk/workflow';

export async function main() {
  const promise = sleep(0);
  Context.cancel(promise);
  await promise;
}
