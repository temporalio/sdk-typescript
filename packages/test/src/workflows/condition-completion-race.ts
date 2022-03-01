/**
 * Tests that the workflow doesn't throw if condition resolves and expires in the same activation
 *
 * @module
 */
import { condition, setHandler } from '@temporalio/workflow';
import { unblockSignal } from './definitions';

export async function conditionRacer(): Promise<void> {
  let blocked = true;
  setHandler(unblockSignal, () => void (blocked = false));
  await condition(() => !blocked, '1s');
  await condition(() => blocked);
}
