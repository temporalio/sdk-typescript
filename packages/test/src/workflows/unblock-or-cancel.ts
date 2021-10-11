/**
 * All-in-one sample showing cancellation, signals and queries
 * @module
 */
// @@@SNIPSTART nodejs-blocked-workflow
import { CancelledFailure, defineSignal, defineQuery, setListener, condition } from '@temporalio/workflow';

export const unblockSignal = defineSignal('unblock');
export const isBlockedQuery = defineQuery<boolean>('isBlocked');

export async function unblockOrCancel(): Promise<void> {
  let isBlocked = true;
  setListener(unblockSignal, () => void (isBlocked = false));
  setListener(isBlockedQuery, () => isBlocked);
  try {
    console.log('Blocked');
    await condition(() => !isBlocked);
    isBlocked = false;
    console.log('Unblocked');
  } catch (err) {
    if (!(err instanceof CancelledFailure)) {
      throw err;
    }
    console.log('Cancelled');
  }
}
// @@@SNIPEND
