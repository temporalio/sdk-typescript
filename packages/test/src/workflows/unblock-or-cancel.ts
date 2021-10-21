/**
 * All-in-one sample showing cancellation, signals and queries
 * @module
 */
import { CancelledFailure, defineQuery, setListener, condition } from '@temporalio/workflow';
import { unblockSignal } from './definitions';

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
