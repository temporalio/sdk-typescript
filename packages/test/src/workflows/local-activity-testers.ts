/**
 * Workflows used by `test-local-activities.ts`
 * @module
 */

import * as wf from '@temporalio/workflow';
import type * as activities from '../activities';

const { echo, isLocal, throwAnError, waitForCancellation } = wf.proxyLocalActivities<typeof activities>({
  startToCloseTimeout: '1m',
});

const { isLocal: nonLocalIsLocal } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '1m',
});

export async function runOneLocalActivity(s: string): Promise<string> {
  return await echo(s);
}

export async function getIsLocal(fromInsideLocal: boolean): Promise<boolean> {
  return await (fromInsideLocal ? isLocal() : nonLocalIsLocal());
}

export async function runParallelLocalActivities(...ss: string[]): Promise<string[]> {
  return await Promise.all(ss.map(echo));
}

export async function throwAnErrorFromLocalActivity(message: string): Promise<void> {
  await throwAnError(true, message);
}

export async function throwAnExplicitNonRetryableErrorFromLocalActivity(message: string): Promise<void> {
  const { throwAnError } = wf.proxyLocalActivities<typeof activities>({
    startToCloseTimeout: '1m',
    retry: { nonRetryableErrorTypes: ['Error'] },
  });

  await throwAnError(false, message);
}

export async function throwARetryableErrorWithASingleRetry(message: string): Promise<void> {
  const { throwAnError } = wf.proxyLocalActivities<typeof activities>({
    startToCloseTimeout: '1m',
    retry: { maximumAttempts: 2 },
  });

  await throwAnError(false, message);
}

export async function cancelALocalActivity(activityType: 'waitForCancellation' | 'throwAnError'): Promise<void> {
  await wf.CancellationScope.cancellable(async () => {
    const p = activityType === 'waitForCancellation' ? waitForCancellation() : throwAnError(false, 'Retry me');
    await wf.sleep(1);
    wf.CancellationScope.current().cancel();
    await p;
  });
}

export async function runSerialLocalActivities(): Promise<void> {
  await echo('1');
  await echo('2');
  await echo('3');
}

export async function throwAnErrorWithBackoff(): Promise<void> {
  const { succeedAfterFirstAttempt } = wf.proxyLocalActivities({
    startToCloseTimeout: '1m',
    localRetryThreshold: '1s',
    retry: { maximumAttempts: 2, initialInterval: '2s' },
  });

  await succeedAfterFirstAttempt();
}

export async function runANonExisitingLocalActivity(): Promise<void> {
  // TODO: default behavior should be to not retry activities that are not found
  const { activityNotFound } = wf.proxyLocalActivities({
    startToCloseTimeout: '1m',
    retry: { maximumAttempts: 1 },
  });

  await activityNotFound();
}

export const interceptors: wf.WorkflowInterceptorsFactory = () => {
  return {
    outbound: [
      {
        async startTimer(input, next) {
          const { test } = wf.proxySinks();
          await next(input);
          test.timerFired();
        },
        async scheduleLocalActivity(input, next) {
          const secret = wf.defaultPayloadConverter.toPayload('shhh');
          if (secret === undefined) {
            throw new Error('Unexpected');
          }
          const output: any = await next({ ...input, headers: { secret } });
          return output + output;
        },
      },
    ],
  };
};
