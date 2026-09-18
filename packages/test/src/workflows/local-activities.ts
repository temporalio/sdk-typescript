import { ApplicationFailure, type RetryPolicy } from '@temporalio/common';
import type { Context as ActivityContext } from '@temporalio/activity';
import * as workflow from '@temporalio/workflow';
import type { LocalActivityOptions } from '@temporalio/workflow';

export async function getRetryPolicyFromActivityInfo(
  retryPolicy: RetryPolicy,
  fromInsideLocal: boolean
): Promise<object | undefined> {
  return await (fromInsideLocal
    ? workflow.proxyLocalActivities({ startToCloseTimeout: '1m', retry: retryPolicy }).retryPolicy()
    : workflow.proxyActivities({ startToCloseTimeout: '1m', retry: retryPolicy }).retryPolicy());
}

export async function runOneLocalActivity(s: string): Promise<string> {
  return await workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).echo(s);
}

export async function runMyLocalActivityWithOption(
  opts: LocalActivityOptions
): Promise<Pick<ActivityContext['info'], 'scheduleToCloseTimeoutMs' | 'startToCloseTimeoutMs'>> {
  return await workflow.proxyLocalActivities(opts).myLocalActivity();
}

export async function getIsLocal(fromInsideLocal: boolean): Promise<boolean> {
  return await (fromInsideLocal
    ? workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).isLocal()
    : workflow.proxyActivities({ startToCloseTimeout: '1m' }).isLocal());
}

export async function runParallelLocalActivities(...ss: string[]): Promise<string[]> {
  return await Promise.all(ss.map(workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).echo));
}

export async function throwAnErrorFromLocalActivity(message: string): Promise<void> {
  await workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).throwAnError(message);
}

export async function cancelALocalActivity(): Promise<void> {
  await workflow.CancellationScope.cancellable(async () => {
    const p = workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).myActivity();
    await workflow.sleep(1);
    workflow.CancellationScope.current().cancel();
    await p;
  });
}

export async function runSerialLocalActivities(): Promise<void> {
  const { echo } = workflow.proxyLocalActivities({ startToCloseTimeout: '1m' });
  await echo('1');
  await echo('2');
  await echo('3');
}

export async function throwAnExplicitNonRetryableErrorFromLocalActivity(message: string): Promise<void> {
  const { throwAnError } = workflow.proxyLocalActivities({
    startToCloseTimeout: '1m',
    retry: { nonRetryableErrorTypes: ['Error'] },
  });

  await throwAnError(false, message);
}

export async function throwARetryableErrorWithASingleRetry(message: string): Promise<void> {
  const { throwAnError } = workflow.proxyLocalActivities({
    startToCloseTimeout: '1m',
    retry: { maximumAttempts: 2 },
  });

  await throwAnError(false, message);
}

export async function throwAnErrorWithBackoff(): Promise<void> {
  const { succeedAfterFirstAttempt } = workflow.proxyLocalActivities({
    startToCloseTimeout: '1m',
    localRetryThreshold: '1s',
    retry: { maximumAttempts: 2, initialInterval: '2s' },
  });

  await succeedAfterFirstAttempt();
}

export async function runOneLocalActivityWithInterceptor(s: string): Promise<string> {
  return await workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).interceptMe(s);
}

export async function runNonExisitingLocalActivity(): Promise<void> {
  const { activityNotFound } = workflow.proxyLocalActivities({
    startToCloseTimeout: '1m',
  });

  try {
    await activityNotFound();
  } catch (err) {
    if (err instanceof ReferenceError) {
      return;
    }
    throw err;
  }
  throw ApplicationFailure.nonRetryable('Unreachable');
}

export async function runUnregisteredLocalActivityWithDefaultWorkflow(): Promise<string> {
  return await workflow.proxyLocalActivities({ startToCloseTimeout: '5s' }).notRegisteredActivity();
}

/**
 * Reproduces https://github.com/temporalio/sdk-typescript/issues/731
 */
export async function issue731(): Promise<void> {
  await workflow.CancellationScope.cancellable(async () => {
    const localActivityPromise = workflow.proxyLocalActivities({ startToCloseTimeout: '1m' }).echo('activity');
    const sleepPromise = workflow.sleep('30s').then(() => 'timer');
    const result = await Promise.race([localActivityPromise, sleepPromise]);
    if (result === 'timer') {
      throw workflow.ApplicationFailure.nonRetryable('Timer unexpectedly beat local activity');
    }
    workflow.CancellationScope.current().cancel();
  });

  await workflow.sleep(100);
}

export const interceptors: workflow.WorkflowInterceptorsFactory = () => {
  return {
    outbound: [
      {
        async startTimer(input, next) {
          const { test } = workflow.proxySinks();
          await next(input);
          test.timerFired();
        },
        async scheduleLocalActivity(input, next) {
          if (input.activityType !== 'interceptMe') return next(input);

          const secret = workflow.defaultPayloadConverter.toPayload('shhh');
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

export async function runLocalActivityWithNonLocalActivitiesDisabled(): Promise<string> {
  const { echo } = workflow.proxyLocalActivities({ startToCloseTimeout: '1m' });
  return await echo('hello from local activity');
}
