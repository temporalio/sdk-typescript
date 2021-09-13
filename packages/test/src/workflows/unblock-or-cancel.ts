/**
 * All-in-one sample showing cancellation, signals and queries
 * @module
 */
// @@@SNIPSTART nodejs-blocked-workflow
import { Trigger, CancelledFailure } from '@temporalio/workflow';
import { Blocked } from '../interfaces';

export const unblockOrCancel: Blocked = () => {
  let blocked = true;
  const unblocked = new Trigger<void>();

  return {
    queries: {
      isBlocked(): boolean {
        return blocked;
      },
    },
    signals: {
      unblock(): void {
        unblocked.resolve();
      },
    },
    async execute(): Promise<void> {
      try {
        console.log('Blocked');
        await unblocked;
        blocked = false;
        console.log('Unblocked');
      } catch (err) {
        if (!(err instanceof CancelledFailure)) {
          throw err;
        }
        console.log('Cancelled');
      }
    },
  };
};
// @@@SNIPEND
