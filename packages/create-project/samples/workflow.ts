// @@@SNIPSTART nodejs-hello-workflow
import { configureActivities } from '@temporalio/workflow';
import { Example } from '../interfaces';
// Only import the activity types
import type * as activities from '../activities';

const { greet } = configureActivities<typeof activities>({
  type: 'remote',
  startToCloseTimeout: '30 minutes',
});

/** A workflow that simply calls an activity */
export const example: Example = (name: string) => {
  return {
    async execute(): Promise<string> {
      return await greet(name);
    },
  };
};
// @@@SNIPEND
