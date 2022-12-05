/**
 * Prior to 1.5.0, `condition(fn, 0)` was treated the same as `condition(..., undefined)`,
 * which means that the condition would block indefinitely and would return undefined once
 * fn evaluates to true, rather than returning true or false.
 */
import { condition, setHandler, defineSignal, sleep, ApplicationFailure } from '@temporalio/workflow';

export const aSignal = defineSignal('a');
export const bSignal = defineSignal('b');

export async function conditionTimeout0(): Promise<number> {
  let counter = 0;

  let aSignalReceived = false;
  setHandler(aSignal, () => {
    aSignalReceived = true;
  });

  let bSignalReceived = false;
  setHandler(bSignal, () => {
    bSignalReceived = true;
  });

  const aResult = await condition(() => aSignalReceived, 0);
  if (aResult === true || aResult === undefined) counter += 1;

  const bResult = await condition(() => bSignalReceived, 0);
  if (bResult === true || bResult === undefined) counter += 10;

  return counter;
}

export async function conditionTimeout0Simple(): Promise<number> {
  let validationTimerFired = false;
  sleep(1000)
    .then(() => (validationTimerFired = true))
    .catch((e) => console.log(e));

  const res = await condition(() => validationTimerFired, 0);
  if (res === false) return 0;
  throw ApplicationFailure.nonRetryable(`Unexpected result: '${res}'`);
}
