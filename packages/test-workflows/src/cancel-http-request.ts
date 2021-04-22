import { cancel, sleep } from '@temporalio/workflow';
import { cancellableFetch } from '@activities';

export async function main(): Promise<void> {
  const promise = cancellableFetch();
  await sleep(3000);
  cancel(promise);
  await promise;
}
