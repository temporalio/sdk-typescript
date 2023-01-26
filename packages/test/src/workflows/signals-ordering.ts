/**
 * Workflow used for testing default signal handler and signal ordering
 *
 * @module
 */

import { setHandler, setDefaultSignalHandler, defineSignal } from '@temporalio/workflow';

const signalA = defineSignal<[number]>('signalA');
const signalB = defineSignal<[number]>('signalB');
const signalC = defineSignal<[number]>('signalC');

export interface ProcessedSignal {
  handler: string;
  signalName?: string;
  args: unknown[];
}

export async function signalsOrdering(): Promise<ProcessedSignal[]> {
  const processedSignals: ProcessedSignal[] = [];

  setHandler(signalA, (...args: unknown[]) => {
    processedSignals.push({ handler: 'signalA', args });
    setHandler(signalA, undefined);
  });
  setHandler(signalB, (...args: unknown[]) => {
    processedSignals.push({ handler: 'signalB', args });
  });
  setDefaultSignalHandler((signalName: string, ...args: unknown[]) => {
    processedSignals.push({ handler: 'default', signalName, args });
  });
  setHandler(signalC, (...args: unknown[]) => {
    processedSignals.push({ handler: 'signalC', args });
  });

  return processedSignals;
}
