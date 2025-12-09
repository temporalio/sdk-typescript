import { sleep, proxyLocalActivities } from '@temporalio/workflow';

const { a, b, c, d } = proxyLocalActivities({ startToCloseTimeout: '5m' });

export async function nestedPromises(): Promise<void> {
  await Promise.all([a().then(() => c()), b().then(() => d())]);
}
