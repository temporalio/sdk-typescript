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

  const queries = {
    isBlocked(): boolean {
      return blocked;
    },
  };

  const signals = {
    unblock(): void {
      unblocked.resolve();
    },
  };

  async function execute(): Promise<void> {
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
  }

  return { execute, signals, queries };
};
// @@@SNIPEND
