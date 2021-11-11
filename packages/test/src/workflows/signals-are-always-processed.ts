import { proxySinks, Sinks, setHandler, defineSignal } from '@temporalio/workflow';

export const incrementSignal = defineSignal('increment');

export interface SignalProcessTestSinks extends Sinks {
  controller: {
    sendSignal(): void;
  };
}

const { controller } = proxySinks<SignalProcessTestSinks>();

export async function signalsAreAlwaysProcessed(): Promise<void> {
  let counter = 0;
  setHandler(incrementSignal, () => void ++counter);
  if (counter === 0) {
    controller.sendSignal();
  }
}
