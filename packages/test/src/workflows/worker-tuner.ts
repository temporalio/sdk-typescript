import { proxyActivities } from '@temporalio/workflow';

const { hiActivity } = proxyActivities<{ hiActivity(): Promise<string> }>({
  startToCloseTimeout: '5s',
});

export async function successString(): Promise<string> {
  return 'success';
}

export async function doesActivity(): Promise<string> {
  await hiActivity();
  return 'success';
}
