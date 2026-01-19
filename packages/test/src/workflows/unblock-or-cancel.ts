/**
 * All-in-one sample showing cancellation, signals and queries
 * @module
 */

// @@@SNIPSTART typescript-workflow-signal-implementation
import { CancelledFailure, defineQuery, setHandler, condition } from '@temporalio/workflow';
import { unblockSignal } from './definitions';

export const isBlockedQuery = defineQuery<boolean>('isBlocked');

export async function unblockOrCancel(): Promise<void> {
  let isBlocked = true;
  setHandler(unblockSignal, () => void (isBlocked = false));
  setHandler(isBlockedQuery, () => isBlocked);
  try {
    await condition(() => !isBlocked);
    isBlocked = false;
  } catch (err) {
    if (!(err instanceof CancelledFailure)) {
      throw err;
    }
  }
}
// @@@SNIPEND
