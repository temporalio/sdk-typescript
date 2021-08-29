import { Context } from '@temporalio/workflow';
import * as activityInterfaces from '../activities';

const activities = Context.configureActivities<typeof activityInterfaces>({
  type: 'remote',
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
