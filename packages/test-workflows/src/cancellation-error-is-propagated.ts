import { cancel, sleep } from '@temporalio/workflow';

export async function main(): Promise<void> {
  const promise = sleep(0);
  cancel(promise);
  await promise;
}
