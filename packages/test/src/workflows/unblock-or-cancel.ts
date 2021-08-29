/**
 * All-in-one sample showing cancellation, signals and queries
 * @module
 */
// @@@SNIPSTART nodejs-blocked-workflow
import { Trigger, CancelledFailure } from '@temporalio/workflow';
import { Blocked } from '../interfaces';

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

async function main(): Promise<void> {
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

export const workflow: Blocked = { main, signals, queries };
// @@@SNIPEND
