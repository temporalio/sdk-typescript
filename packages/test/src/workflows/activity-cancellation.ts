import { cancel } from '@temporalio/workflow';
import { httpGet } from '@activities';

export async function main(): Promise<void> {
  const promise = httpGet('https://google.com');
  cancel(promise);
  await promise;
}
