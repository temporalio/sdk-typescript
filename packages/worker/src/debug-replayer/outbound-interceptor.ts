/**
 * Debug replayer workflow outbound interceptors.
 * Notify the runner when outbound operations resolve, required for setting breakpoints on workflow tasks.
 *
 * @module
 */
import { WorkflowInterceptorsFactory } from '@temporalio/workflow';
import { notifyRunner } from './workflow-notifier';

export const interceptors: WorkflowInterceptorsFactory = () => ({
  outbound: [
    {
      async scheduleActivity(input, next) {
        try {
          return await next(input);
        } finally {
          notifyRunner();
        }
      },
      async scheduleLocalActivity(input, next) {
        try {
          return await next(input);
        } finally {
          notifyRunner();
        }
      },
      async startTimer(input, next) {
        try {
          return await next(input);
        } finally {
          notifyRunner();
        }
      },
      async signalWorkflow(input, next) {
        try {
          return await next(input);
        } finally {
          notifyRunner();
        }
      },
      async startChildWorkflowExecution(input, next) {
        const [startPromise, completePromise] = await next(input);
        startPromise.finally(notifyRunner).catch(() => {});
        completePromise.finally(notifyRunner).catch(() => {});
        return [startPromise, completePromise];
      },
    },
  ],
});
