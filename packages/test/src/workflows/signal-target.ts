/**
 * Workflow that can be failed and unblocked using signals.
 * Useful for testing Workflow interactions.
 *
 * @module
 */
import { condition, setHandler } from '@temporalio/workflow';
import { failWithMessageSignal, unblockSignal } from './definitions';

export async function signalTarget(): Promise<void> {
  let unblocked = false;

  setHandler(failWithMessageSignal, (message) => {
    throw new Error(message);
  });
  setHandler(unblockSignal, () => void (unblocked = true));

  await condition(() => unblocked);
}
