/**
 * Workflow that can be failed and unblocked using signals.
 * Useful for testing Workflow interactions.
 *
 * @module
 */
import { condition, setListener } from '@temporalio/workflow';
import { failWithMessageSignal, unblockSignal } from './definitions';

export async function signalTarget(): Promise<void> {
  let unblocked = false;

  setListener(failWithMessageSignal, (message) => {
    throw new Error(message);
  });
  setListener(unblockSignal, () => void (unblocked = true));

  await condition(() => unblocked);
}
