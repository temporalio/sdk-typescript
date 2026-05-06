/**
 * Workflow used by test-signals-are-always-processed.ts
 *
 * @module
 */

import type { Sinks } from '@temporalio/workflow';
import { proxySinks, setHandler, defineSignal } from '@temporalio/workflow';

export const incrementSignal = defineSignal('increment');

export interface SignalProcessTestSinks extends Sinks {
  controller: {
    sendSignal(): void;
  };
}

const { controller } = proxySinks<SignalProcessTestSinks>();

export async function signalsAreAlwaysProcessed(): Promise<void> {
  let counter = 0;
  // We expect the signal to be buffered by the runtime and delivered as soon
  // as we set the handler.
  setHandler(incrementSignal, () => void ++counter);
  // Use a sink to block the workflow from completing and send a signal
  if (counter === 0) {
    controller.sendSignal();
  }
}
