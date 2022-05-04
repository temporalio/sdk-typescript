/**
 * Workflow used by integration-tests.ts: signal handlers can be cleared
 *
 * @module
 */

import { setHandler, sleep } from '@temporalio/workflow';
import { unblockSignal } from './definitions';

export async function signalHandlersCanBeCleared(): Promise<number> {
  let counter = 0;

  // Give time for signals to be received and buffered BEFORE the handler is configured. See issue #612 for details.
  await sleep('20ms');

  // Each handler below should catch a single occurence of the unblock signal.
  // sleep() between each to make sure that any pending microtask has been run before the next handler is set
  // If everything went ok, counter should equals 111 at the end.

  setHandler(unblockSignal, () => {
    counter += 1;
    setHandler(unblockSignal, undefined);
  });

  await sleep('1ms');

  setHandler(unblockSignal, () => {
    counter += 10;
    setHandler(unblockSignal, undefined);
  });

  await sleep('1ms');

  setHandler(unblockSignal, () => {
    counter += 100;
  });

  return counter;
}
