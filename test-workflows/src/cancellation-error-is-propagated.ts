import { cancel, sleep } from '@temporal-sdk/workflow';

export async function main() {
  const promise = sleep(0);
  cancel(promise);
  await promise;
}
