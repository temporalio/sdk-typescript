import type { temporal } from '@temporalio/proto';
import { ValueError } from './errors';
import { msOptionalToNumber, msOptionalToTs, msToNumber, msToTs } from './time';

/**
 * Options for retrying Workflows and Activities
 */
export interface RetryPolicy {
  /**
   * Coefficient used to calculate the next retry interval.
   * The next retry interval is previous interval multiplied by this coefficient.
   * @minimum 1
   * @default 2
   */
  backoffCoefficient?: number;
  /**
   * Interval of the first retry.
   * If coefficient is 1 then it is used for all retries
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   * @default 1 second
   */
  initialInterval?: string | number;
  /**
   * Maximum number of attempts. When exceeded the retries stop even if not expired yet.
   * @minimum 1
   * @default Infinity
   */
  maximumAttempts?: number;
  /**
   * Maximum interval between retries.
   * Exponential backoff leads to interval increase.
   * This value is the cap of the increase.
   *
   * @default 100x of {@link initialInterval}
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   */
  maximumInterval?: string | number;

  /**
   * List of application failures types to not retry.
   */
  nonRetryableErrorTypes?: string[];
}

/**
 * Turns a TS RetryPolicy into a proto compatible RetryPolicy
 */
export function compileRetryPolicy(retryPolicy: RetryPolicy): temporal.api.common.v1.IRetryPolicy {
  if (retryPolicy.backoffCoefficient != null && retryPolicy.backoffCoefficient <= 0) {
    throw new ValueError('RetryPolicy.backoffCoefficient must be greater than 0');
  }
  if (retryPolicy.maximumAttempts != null) {
    if (retryPolicy.maximumAttempts <= 0) {
      throw new ValueError('RetryPolicy.maximumAttempts must be greater than 0');
    }

    if (!Number.isInteger(retryPolicy.maximumAttempts)) {
      throw new ValueError('RetryPolicy.maximumAttempts must be an integer');
    }
  }
  const maximumInterval = msOptionalToNumber(retryPolicy.maximumInterval);
  const initialInterval = msToNumber(retryPolicy.initialInterval ?? 1000);
  if (maximumInterval === 0) {
    throw new ValueError('RetryPolicy.maximumInterval cannot be 0');
  }
  if (initialInterval === 0) {
    throw new ValueError('RetryPolicy.initialInterval cannot be 0');
  }
  if (maximumInterval != null && maximumInterval < initialInterval) {
    throw new ValueError('RetryPolicy.maximumInterval cannot be less than its initialInterval');
  }
  return {
    maximumAttempts: retryPolicy.maximumAttempts,
    initialInterval: msToTs(initialInterval),
    maximumInterval: msOptionalToTs(maximumInterval),
    backoffCoefficient: retryPolicy.backoffCoefficient,
    nonRetryableErrorTypes: retryPolicy.nonRetryableErrorTypes,
  };
}
