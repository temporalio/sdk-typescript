import assert from 'assert';
import { ApplicationFailure, WorkflowInterceptors } from '@temporalio/workflow';

/**
 * Simple interceptor that transforms {@link assert.AssertionError} into non retryable failures.
 *
 * This allows conveniently using `assert` directly from Workflows.
 */
export function interceptors(): WorkflowInterceptors {
  return {
    inbound: [
      {
        async handleSignal(input, next) {
          try {
            return await next(input);
          } catch (err) {
            if (err instanceof assert.AssertionError) {
              const appErr = ApplicationFailure.nonRetryable(err.message);
              appErr.stack = err.stack;
              throw appErr;
            }
            throw err;
          }
        },
        async execute(input, next) {
          try {
            return await next(input);
          } catch (err) {
            if (err instanceof assert.AssertionError) {
              const appErr = ApplicationFailure.nonRetryable(err.message);
              appErr.stack = err.stack;
              throw appErr;
            }
            throw err;
          }
        },
      },
    ],
  };
}
