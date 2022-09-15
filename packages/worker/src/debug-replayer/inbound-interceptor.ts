/**
 * Debug replayer workflow inbound interceptors.
 * Notify the runner when workflow starts or a signal is received, required for setting breakpoints on workflow tasks.
 *
 * @module
 */
import { WorkflowInterceptorsFactory } from '@temporalio/workflow';
import { notifyRunner } from './workflow-notifier';

export const interceptors: WorkflowInterceptorsFactory = () => ({
  inbound: [
    {
      execute(input, next) {
        notifyRunner();
        return next(input);
      },
      handleSignal(input, next) {
        notifyRunner();
        return next(input);
      },
    },
  ],
});
