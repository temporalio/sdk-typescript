/**
 * Workflow that can be failed and unblocked using signals.
 * Useful for testing Workflow interactions.
 *
 * @module
 */
import { Trigger } from '@temporalio/workflow';
import { SignalTarget } from '../interfaces';

const unblocked = new Trigger<void>();

export const signalTarget: SignalTarget = () => ({
  signals: {
    fail(message: string): void {
      throw new Error(message);
    },
    unblock(): void {
      unblocked.resolve();
    },
  },

  async execute(): Promise<void> {
    await unblocked;
  },
});
