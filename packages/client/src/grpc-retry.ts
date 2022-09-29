import { InterceptingCall, Interceptor, ListenerBuilder, RequesterBuilder, StatusObject } from '@grpc/grpc-js';
import * as grpc from '@grpc/grpc-js';

/**
 * @experimental
 */
export interface GrpcRetryOptions {
  /**
   * A function which accepts the current retry attempt (starts at 1) and returns the millisecond
   * delay that should be applied before the next retry.
   */
  delayFunction: (attempt: number, status: StatusObject) => number;

  /**
   * A function which accepts a failed status object and returns true if the call should be retried
   */
  retryableDecider: (attempt: number, status: StatusObject) => boolean;
}

/**
 * Options for the backoff formula: `factor ^ attempt * initialIntervalMs(status) * jitter(maxJitter)`
 *
 * @experimental
 */
export interface BackoffOptions {
  /**
   * Exponential backoff factor
   *
   * @default 2
   */
  factor: number;

  /**
   * Maximum number of attempts
   *
   * @default 10
   */
  maxAttempts: number;
  /**
   * Maximum amount of jitter to apply
   *
   * @default 0.1
   */
  maxJitter: number;
  /**
   * Function that returns the "initial" backoff interval based on the returned status.
   *
   * The default is 1 second for RESOURCE_EXHAUSTED errors and 20 millis for other retryable errors.
   */
  initialIntervalMs(status: StatusObject): number;

  /**
   * Function that returns the "maximum" backoff interval based on the returned status.
   *
   * The default is 10 seconds regardless of the status.
   */
  maxIntervalMs(status: StatusObject): number;
}

/**
 * Add defaults as documented in {@link BackoffOptions}
 */
function withDefaultBackoffOptions({
  maxAttempts,
  factor,
  maxJitter,
  initialIntervalMs,
}: Partial<BackoffOptions>): BackoffOptions {
  return {
    maxAttempts: maxAttempts ?? 10,
    factor: factor ?? 2,
    maxJitter: maxJitter ?? 0.1,
    initialIntervalMs: initialIntervalMs ?? defaultInitialIntervalMs,
    maxIntervalMs() {
      return 10_000;
    },
  };
}

/**
 * Generates the default retry behavior based on given backoff options
 *
 * @experimental
 */
export function defaultGrpcRetryOptions(options: Partial<BackoffOptions> = {}): GrpcRetryOptions {
  const { maxAttempts, factor, maxJitter, initialIntervalMs, maxIntervalMs } = withDefaultBackoffOptions(options);
  return {
    delayFunction(attempt, status) {
      return Math.min(maxIntervalMs(status), factor ** attempt * initialIntervalMs(status)) * jitter(maxJitter);
    },
    retryableDecider(attempt, status) {
      return attempt < maxAttempts && isRetryableError(status);
    },
  };
}

/**
 * Set of retryable gRPC status codes
 */
const retryableCodes = new Set([
  grpc.status.UNKNOWN,
  grpc.status.RESOURCE_EXHAUSTED,
  grpc.status.UNAVAILABLE,
  grpc.status.ABORTED,
  grpc.status.DATA_LOSS,
  grpc.status.OUT_OF_RANGE,
]);

export function isRetryableError(status: StatusObject): boolean {
  return retryableCodes.has(status.code);
}

/**
 * Calculates random amount of jitter between 0 and `max`
 */
function jitter(max: number) {
  return 1 - max + Math.random() * max * 2;
}

/**
 * Default implementation - backs off more on RESOURCE_EXHAUSTED errors
 */
function defaultInitialIntervalMs({ code }: StatusObject) {
  // Backoff more on RESOURCE_EXHAUSTED
  if (code === grpc.status.RESOURCE_EXHAUSTED) {
    return 1000;
  }
  return 20;
}

/**
 * Returns a GRPC interceptor that will perform automatic retries for some types of failed calls
 *
 * @param retryOptions Options for the retry interceptor
 *
 * @experimental
 */
export function makeGrpcRetryInterceptor(retryOptions: GrpcRetryOptions): Interceptor {
  return (options, nextCall) => {
    let savedSendMessage: any;
    let savedReceiveMessage: any;
    let savedMessageNext: (message: any) => void;

    const requester = new RequesterBuilder()
      .withStart(function (metadata, _listener, next) {
        // First attempt
        let attempt = 1;

        const listener = new ListenerBuilder()
          .withOnReceiveMessage((message, next) => {
            savedReceiveMessage = message;
            savedMessageNext = next;
          })
          .withOnReceiveStatus((status, next) => {
            const retry = () => {
              attempt++;
              const call = nextCall(options);
              call.start(metadata, {
                onReceiveMessage(message) {
                  savedReceiveMessage = message;
                },
                onReceiveStatus,
              });
              call.sendMessage(savedSendMessage);
              call.halfClose();
            };

            const onReceiveStatus = (status: StatusObject) => {
              if (retryOptions.retryableDecider(attempt, status)) {
                setTimeout(retry, retryOptions.delayFunction(attempt, status));
              } else {
                savedMessageNext(savedReceiveMessage);
                // TODO: For reasons that are completely unclear to me, if you pass a handcrafted
                // status object here, node will magically just exit at the end of this line.
                // No warning, no nothing. Here be dragons.
                next(status);
              }
            };

            onReceiveStatus(status);
          })
          .build();
        next(metadata, listener);
      })
      .withSendMessage((message, next) => {
        savedSendMessage = message;
        next(message);
      })
      .build();
    return new InterceptingCall(nextCall(options), requester);
  };
}
