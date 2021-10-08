import { defineSignal } from '@temporalio/workflow';
// @@@SNIPSTART nodejs-external-dependencies-logger-interface
import { ExternalDependencies } from '@temporalio/workflow';

export interface LoggerDependencies extends ExternalDependencies {
  logger: {
    info(message: string): void;
  };
}
// @@@SNIPEND

export const activityStartedSignal = defineSignal('activityStarted');
export const failSignal = defineSignal('fail');
export const failWithMessageSignal = defineSignal<[string]>('fail');
export const unblockSignal = defineSignal('unblock');
