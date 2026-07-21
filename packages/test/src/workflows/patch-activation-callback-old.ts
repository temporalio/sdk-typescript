import { condition, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';

export const finishPatchActivationWorkflow = defineSignal('finishPatchActivationWorkflow');
export const patchActivationResult = defineQuery<boolean>('patchActivationResult');

export async function patchActivationRolloutWorkflow(): Promise<'old'> {
  let finish = false;
  setHandler(patchActivationResult, () => false);
  setHandler(finishPatchActivationWorkflow, () => {
    finish = true;
  });
  await condition(() => finish);
  return 'old';
}
