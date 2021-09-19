// @@@SNIPSTART nodejs-activity-from-class-workflow
import { createActivityHandle } from '@temporalio/workflow';
import type { ActivitiesWithDependencies } from '../activities/with-deps';
import { Returner } from '../interfaces';

const { greet } = createActivityHandle<ActivitiesWithDependencies>({
  startToCloseTimeout: '1 minute',
});

export const runActivityFromClass: Returner<string> = () => ({
  async execute() {
    return await greet('temporal');
  },
});
// @@@SNIPEND
