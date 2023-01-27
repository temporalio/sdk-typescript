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

export async function signalsOrdering2(): Promise<ProcessedSignal[]> {
  const processedSignals: ProcessedSignal[] = [];

  function handlerA(...args: unknown[]) {
    processedSignals.push({ handler: 'signalA', args });
    setHandler(signalA, undefined);
    setHandler(signalB, handlerB);
  }

  function handlerB(...args: unknown[]) {
    processedSignals.push({ handler: 'signalB', args });
    setHandler(signalB, undefined);
    setHandler(signalC, handlerC);
  }

  function handlerC(...args: unknown[]) {
    processedSignals.push({ handler: 'signalC', args });
    setHandler(signalC, undefined);
    setDefaultSignalHandler(handlerDefault);
  }

  function handlerDefault(signalName: string, ...args: unknown[]) {
    processedSignals.push({ handler: 'default', signalName, args });
    setDefaultSignalHandler(undefined);
    setHandler(signalA, handlerA);
  }

  setHandler(signalA, handlerA);

  return processedSignals;
}
