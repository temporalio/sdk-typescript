import { proxyActivities } from '@temporalio/workflow';
import type * as activityInterfaces from '../activities';

const activities = proxyActivities<typeof activityInterfaces>({
  startToCloseTimeout: '10m',
});

export const {
  httpGet,
  echo,
  setup,
  cleanup,
  httpGetJSON,
  httpPostJSON,
  fakeProgress,
  waitForCancellation,
  throwAnError,
  cancellableFetch,
  progressiveSleep,
} = activities;
