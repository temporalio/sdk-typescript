import type { Logger, MetricCounter, MetricHistogram, MetricMeter } from '@temporalio/common';
import { noopMetricMeter } from '@temporalio/common';

// Metric and label names must be the same across SDKs

const METRIC_FETCH_FAILED = 'temporal_aws_secrets_manager_fetch_failed';
const METRIC_FETCH_LATENCY = 'temporal_aws_secrets_manager_fetch_latency';
const METRIC_CACHE_LOOKUP = 'temporal_aws_secrets_manager_cache_lookup';

export const LABEL_SECRET_TYPE = 'secret_type';
export const LABEL_FETCH_PATH = 'fetch_path';
export const LABEL_FAILURE_REASON = 'failure_reason';
export const LABEL_FALLBACK = 'fallback';
export const LABEL_OUTCOME = 'outcome';
export const LABEL_RESULT = 'result';

/**
 * secret_type label values. Client cert and key secrets are fetched together and reported as
 * `tls_client_cert` in metrics.
 */
export type SecretType = 'api_key' | 'tls_client_cert' | 'tls_client_key' | 'tls_server_ca_cert';

/** fetch_path label values: the Lambda extension, or a direct fetch with the AWS SDK */
export type FetchPath = 'extension' | 'sdk';

export type LookupResult = 'hit' | 'miss' | 'miss_with_fallback';

export type FailureReason =
  | 'resource_not_found'
  | 'access_denied'
  | 'decryption_failure'
  | 'invalid_request'
  | 'throttling'
  | 'internal_service_error'
  | 'timeout'
  | 'invalid_response'
  // The Lambda extension doesn't return the underlying AWS error, only an HTTP status with a generic
  // message, so its errors are only classified by status class
  | 'client_error'
  | 'server_error'
  | 'other';

// AWS error names mapped to failure reasons. Other names are 'other'.
const AWS_ERROR_FAILURE_REASONS = new Map<string, FailureReason>([
  ['ResourceNotFoundException', 'resource_not_found'],
  ['AccessDeniedException', 'access_denied'],
  ['DecryptionFailure', 'decryption_failure'],
  ['InvalidRequestException', 'invalid_request'],
  ['InvalidParameterException', 'invalid_request'],
  ['ThrottlingException', 'throttling'],
  ['InternalServiceError', 'internal_service_error'],
]);

/** A response that was received but has no usable secret value. */
export class InvalidResponseError extends Error {
  override name = 'InvalidResponseError';
}

/** A non-200 response from the Lambda extension. */
export class LambdaExtensionStatusError extends Error {
  override name = 'LambdaExtensionStatusError';

  constructor(
    readonly status: number,
    body: string
  ) {
    super(`AWS Parameters and Secrets Lambda Extension returned status ${status}: ${body}`);
  }
}

/** A fetch that took longer than the fetch timeout. */
export class FetchTimeoutError extends Error {
  override name = 'FetchTimeoutError';
}

/** Returns the failure_reason metric label for a fetch error. */
export function classifyFailure(err: unknown): FailureReason {
  if (err instanceof InvalidResponseError) {
    return 'invalid_response';
  }
  if (err instanceof LambdaExtensionStatusError) {
    if (err.status >= 400 && err.status < 500) return 'client_error';
    if (err.status >= 500 && err.status < 600) return 'server_error';
    return 'other';
  }
  if (err instanceof FetchTimeoutError) {
    return 'timeout';
  }
  // AWS SDK service exceptions are named after the error code
  return (err instanceof Error && AWS_ERROR_FAILURE_REASONS.get(err.name)) || 'other';
}

/** Metric instruments and logger for a connection's runtime. */
export class Telemetry {
  readonly fetchFailed: MetricCounter;
  readonly fetchLatency: MetricHistogram;
  readonly cacheLookup: MetricCounter;

  constructor(
    meter: MetricMeter,
    readonly logger?: Logger
  ) {
    this.fetchFailed = meter.createCounter(
      METRIC_FETCH_FAILED,
      undefined,
      'Failed fetches of AWS Secrets Manager secrets'
    );
    this.fetchLatency = meter.createHistogram(
      METRIC_FETCH_LATENCY,
      'int',
      'ms',
      'Latency of AWS Secrets Manager secret fetches'
    );
    this.cacheLookup = meter.createCounter(
      METRIC_CACHE_LOOKUP,
      undefined,
      'Lookups of cached AWS Secrets Manager secrets that returned a value'
    );
  }

  /**
   * Records a metric or log, never throwing, e.g. if the runtime that owns the meter or logger has
   * shut down. Recording failures shouldn't affect fetching secrets.
   */
  record(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      try {
        this.logger?.warn('Failed recording AWS Secrets Manager telemetry', { error: err });
      } catch {
        // Nowhere left to report it
      }
    }
  }
}

/** Telemetry that records nothing, for connections without a runtime. */
export const noopTelemetry = new Telemetry(noopMetricMeter);
