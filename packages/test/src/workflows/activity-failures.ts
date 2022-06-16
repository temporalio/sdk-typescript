/**
 * Tests different activity failures
 * - NonRetryableError - as configured in ActivityOptions.nonRetryableErrorTypes
 * - RetryableError - just a normal failure class
 * - NonRetryableApplicationFailureWithNonRetryableFlag
 * - NonRetryableApplicationFailureWithRetryableFlag
 * - RetryableApplicationFailureWithRetryableFlag
 * - RetryableApplicationFailureWithNonRetryableFlag
 * - RetryableApplicationFailureWithDetails
 *
 * @module
 */

import { proxyActivities } from '@temporalio/workflow';
import { ActivityFailure, ApplicationFailure, RetryState } from '@temporalio/common';
import type * as activities from '../activities';

const { throwSpecificError } = proxyActivities<typeof activities>({
  startToCloseTimeout: '20s',
  retry: { initialInterval: 5, maximumAttempts: 1, nonRetryableErrorTypes: ['NonRetryableError'] },
});

async function assertThrows<T extends Error>(p: Promise<any>, ctor: new (...args: any[]) => T): Promise<T> {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof ctor)) {
      throw new Error(`Expected activity to throw a ${ctor}, got: ${err}`);
    }
    return err;
  }
  throw ApplicationFailure.nonRetryable('Expected activity to throw');
}

export function assertApplicationFailure(
  err: Error | undefined,
  type: string,
  nonRetryable: boolean,
  originalMessage: string
): asserts err is ApplicationFailure {
  if (!(err instanceof ApplicationFailure)) {
    throw new Error(`Expected ApplicationFailure, got ${err}`);
  }
  if (err.type !== type || err.nonRetryable != nonRetryable || err.message !== originalMessage) {
    throw ApplicationFailure.nonRetryable(
      `Expected ${type} with nonRetryable=${nonRetryable} originalMessage=${originalMessage}, got ${err}`
    );
  }
}

function assertRetryState(err: ActivityFailure, retryState: RetryState) {
  if (err.retryState !== retryState) {
    throw ApplicationFailure.nonRetryable(`Expected retryState to be ${retryState}, got ${err.retryState}`);
  }
}

export async function activityFailures(): Promise<void> {
  {
    const err = await assertThrows(throwSpecificError('RetryableError', '1'), ActivityFailure);
    assertRetryState(err, RetryState.RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED);
    assertApplicationFailure(err.cause, 'RetryableError', false, '1');
  }
  {
    const err = await assertThrows(throwSpecificError('NonRetryableError', '2'), ActivityFailure);
    assertRetryState(err, RetryState.RETRY_STATE_NON_RETRYABLE_FAILURE);
    assertApplicationFailure(err.cause, 'NonRetryableError', false, '2');
  }
  {
    const err = await assertThrows(throwSpecificError('CustomError', '2'), ActivityFailure);
    assertRetryState(err, RetryState.RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED);
    assertApplicationFailure(err.cause, 'CustomError', false, '2');
  }
  {
    const err = await assertThrows(
      throwSpecificError('RetryableApplicationFailureWithRetryableFlag', '3'),
      ActivityFailure
    );
    assertRetryState(err, RetryState.RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED);
    assertApplicationFailure(err.cause, 'RetryableError', false, '3');
  }
  {
    const err = await assertThrows(
      throwSpecificError('RetryableApplicationFailureWithNonRetryableFlag', '4'),
      ActivityFailure
    );
    assertRetryState(err, RetryState.RETRY_STATE_NON_RETRYABLE_FAILURE);
    assertApplicationFailure(err.cause, 'RetryableError', true, '4');
  }
  {
    const err = await assertThrows(
      throwSpecificError('NonRetryableApplicationFailureWithRetryableFlag', '5'),
      ActivityFailure
    );
    assertRetryState(err, RetryState.RETRY_STATE_NON_RETRYABLE_FAILURE);
    assertApplicationFailure(err.cause, 'NonRetryableError', false, '5');
  }
  {
    const err = await assertThrows(
      throwSpecificError('NonRetryableApplicationFailureWithNonRetryableFlag', '6'),
      ActivityFailure
    );
    assertRetryState(err, RetryState.RETRY_STATE_NON_RETRYABLE_FAILURE);
    assertApplicationFailure(err.cause, 'NonRetryableError', true, '6');
  }
  {
    const err = await assertThrows(throwSpecificError('RetryableApplicationFailureWithDetails', '7'), ActivityFailure);
    assertRetryState(err, RetryState.RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED);
    assertApplicationFailure(err.cause, 'RetryableError', false, '7');
    const [detail1, detail2] = err.cause.details as [string, string];
    if (!(detail1 === 'detail1' && detail2 === 'detail2')) {
      throw new Error(`Expected error details to be 'detail1,detail2', got: ${err.cause.details}`);
    }
  }
}
