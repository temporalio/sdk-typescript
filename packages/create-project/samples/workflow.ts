// @@@SNIPSTART nodejs-hello-workflow
import { createActivityHandle } from '@temporalio/workflow';
import { Example } from '../interfaces';
// Only import the activity types
import type * as activities from '../activities';

const { greet } = createActivityHandle<typeof activities>({
  startToCloseTimeout: '1 minute',
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
