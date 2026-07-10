import { condition, defineQuery, defineSignal, patched, setHandler } from '@temporalio/workflow';

export const finishPatchActivationWorkflow = defineSignal('finishPatchActivationWorkflow');
export const patchActivationResult = defineQuery<boolean>('patchActivationResult');

export async function patchActivationRolloutWorkflow(): Promise<'old' | 'new'> {
  const activated = patched('patch-activation-callback-rollout');
  let finish = false;
  setHandler(patchActivationResult, () => activated);
  setHandler(finishPatchActivationWorkflow, () => {
    finish = true;
  });
  await condition(() => finish);
  return activated ? 'new' : 'old';
}
