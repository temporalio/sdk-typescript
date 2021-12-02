import { defineSignal } from '@temporalio/workflow';
// @@@SNIPSTART typescript-logger-sink-interface
import { Sinks } from '@temporalio/workflow';

export interface LoggerSinks extends Sinks {
  logger: {
    info(message: string): void;
  };
}
// @@@SNIPEND

export const activityStartedSignal = defineSignal('activityStarted');
export const failSignal = defineSignal('fail');
export const failWithMessageSignal = defineSignal<[string]>('fail');
export const argsTestSignal = defineSignal<[number, string]>('argsTest');
export const unblockSignal = defineSignal('unblock');
