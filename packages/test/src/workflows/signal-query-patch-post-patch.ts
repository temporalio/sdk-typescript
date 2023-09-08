/**
 * Post-patched version of a workflow used to reproduce an issue with signal+query+patch
 *
 * @module
 */
import * as wf from '@temporalio/workflow';

export async function patchQuerySignal(): Promise<boolean> {
  let enteredPatchBlock = false;

  wf.setHandler(wf.defineQuery<boolean, [string]>('query'), () => true);
  wf.setHandler(wf.defineSignal('signal'), () => {
    // This block should not execute, since the patch did not get registered when the signal was first handled.
    if (wf.patched('should_never_be_set')) {
      enteredPatchBlock = true;
    }
  });

  let blocked = true;
  wf.setHandler(wf.defineSignal('unblock'), () => {
    blocked = false;
  });
  await wf.condition(() => !blocked);

  return enteredPatchBlock;
}
