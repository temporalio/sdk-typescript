/**
 * Workflow that can be failed and unblocked using signals.
 * Useful for testing Workflow interactions.
 *
 * @module
 */
import { condition, setHandler } from '@temporalio/workflow';
import { argsTestSignal, failWithMessageSignal, unblockSignal } from './definitions';

export async function signalTarget(): Promise<void> {
  let unblocked = false;

  // Verify arguments are sent correctly
  setHandler(argsTestSignal, (num, str) => {
    if (!(num === 123 && str === 'kid')) {
      throw new Error('Invalid arguments');
    }
  });
  setHandler(failWithMessageSignal, (message) => {
    throw new Error(message);
  });
  setHandler(unblockSignal, () => void (unblocked = true));

  await condition(() => unblocked);
}
