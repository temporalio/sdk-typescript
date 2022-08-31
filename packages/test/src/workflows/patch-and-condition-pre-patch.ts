/**
 * Pre-patched version of a workflow used to reproduce an issue with patch inside a condition.
 *
 * @module
 */
import * as wf from '@temporalio/workflow';

export const generateCommandSignal = wf.defineSignal('generate-command');

/**
 * Unpatched version of the workflow - just sleep and set up our signal handler
 */
export async function patchInCondition(): Promise<void> {
  // The signal handler here is important for the repro.
  // We use it so the workflow generates a command that will conflict with the patch.
  wf.setHandler(generateCommandSignal, async () => {
    // Ignore completion, it's irrelevant, just generate a command
    await wf.sleep('1s');
  });

  await wf.sleep('5s');
}
