/**
 * Pre-patched version of a workflow used to reproduce an issue with signal+query+patch
 *
 * @module
 */
import * as wf from '@temporalio/workflow';

export async function patchQuerySignal(): Promise<boolean> {
  wf.setHandler(wf.defineQuery<boolean, [string]>('query'), () => true);
  wf.setHandler(wf.defineSignal('signal'), () => {
    // Nothing. In post-patch version, there will be a block here, surrounded by a patch check.
  });

  let blocked = true;
  wf.setHandler(wf.defineSignal('unblock'), () => {
    blocked = false;
  });
  await wf.condition(() => !blocked);

  throw new Error('Execution should not reach this point in pre-patch version');
}
