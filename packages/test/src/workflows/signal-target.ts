/**
 * Workflow that can be failed and unblocked using signals.
 * Useful for testing Workflow interactions.
 *
 * @module
 */
import { Trigger } from '@temporalio/workflow';

const unblocked = new Trigger<void>();

const signals = {
  fail(message: string): void {
    throw new Error(message);
  },
  unblock(): void {
    unblocked.resolve();
  },
};

async function execute(): Promise<void> {
  await unblocked;
}

export const workflow = { execute, signals };
