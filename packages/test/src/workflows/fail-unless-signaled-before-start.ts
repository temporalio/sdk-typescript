import { defineSignal, setListener } from '@temporalio/workflow';

export const someShallPassSignal = defineSignal('someShallPass');

export async function failUnlessSignaledBeforeStart(): Promise<void> {
  let pass = false;
  setListener(someShallPassSignal, () => void (pass = true));
  if (!pass) {
    throw new Error('None shall pass');
  }
}
