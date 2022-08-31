/**
 * Post-patched version of a workflow used to reproduce an issue with patch inside a condition.
 *
 * Uses a patched statement inside a condition to replicate a bug where the runtime could generate out of order
 * commands on replay.
 *
 * @module
 */
import * as wf from '@temporalio/workflow';
import { generateCommandSignal } from './patch-and-condition-pre-patch';

/**
 * Patches the workflow from ./patch-and-condition-pre-patch, adds a patched statement inside a condition.
 *
 */
export async function patchInCondition(): Promise<void> {
  // The signal handler here is important for the repro.
  // We use it so the workflow generates a command that will conflict with the patch.
  wf.setHandler(generateCommandSignal, async () => {
    // Ignore completion, it's irrelevant, just generate a command
    await wf.sleep('1s');
  });

  // Note that the condition always returns false, we don't want it to resolve the promise, just to using it to test the
  // edge case.
  await Promise.race([wf.sleep('5s'), wf.condition(() => wf.patched('irrelevant') && false)]);
}
