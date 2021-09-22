import {
  InterceptingCall,
  Interceptor,
  ListenerBuilder,
  Metadata,
  RequesterBuilder,
  StatusObject,
} from '@grpc/grpc-js';
import * as grpc from '@grpc/grpc-js';

export interface GrpcRetryOptions {
  // Maximum number of allowed retries. Defaults to 10.
  maxRetries: number;

  /**
   * A function which accepts the current retry attempt (starts at 0) and returns the millisecond
   * delay that should be applied before the next retry.
   */
  delayFunction: (attempt: number) => number;

  /**
   * A function which accepts a failed status object and returns true if the call should be retried
   */
  retryableDecider: (status: StatusObject) => boolean;
}

export function defaultGrpcRetryOptions(): GrpcRetryOptions {
  return {
    maxRetries: 10,
    delayFunction: backOffAmount,
    retryableDecider: isRetryableError,
  };
}

const retryableCodes = new Set([
  grpc.status.UNKNOWN,
  grpc.status.RESOURCE_EXHAUSTED,
  grpc.status.UNAVAILABLE,
  grpc.status.ABORTED,
  grpc.status.DATA_LOSS,
  grpc.status.OUT_OF_RANGE,
]);

function isRetryableError(status: StatusObject): boolean {
  return retryableCodes.has(status.code);
}

// Return backoff amount in ms
function backOffAmount(attempt: number): number {
  return 2 ** attempt * 20;
}

/**
 * Returns a GRPC interceptor that will perform automatic retries for some types of failed calls
 *
 * @param retryOptions Options for the retry interceptor
 */
export function makeGrpcRetryInterceptor(retryOptions: GrpcRetryOptions): Interceptor {
  return (options, nextCall) => {
    let savedMetadata: Metadata;
    let savedSendMessage: any;
    let savedReceiveMessage: any;
    let savedMessageNext: any;
    const requester = new RequesterBuilder()
      .withStart(function (metadata, listener, next) {
        savedMetadata = metadata;
        const newListener = new ListenerBuilder()
          .withOnReceiveMessage((message, next) => {
            savedReceiveMessage = message;
            savedMessageNext = next;
          })
          .withOnReceiveStatus((status, next) => {
            let retries = 0;
            const retry = function (message: any, metadata: Metadata) {
              retries++;
              const newCall = nextCall(options);
              newCall.start(metadata, {
                onReceiveMessage: (message) => {
                  savedReceiveMessage = message;
                },
                onReceiveStatus: (status) => {
                  if (retryOptions.retryableDecider(status)) {
                    if (retries <= retryOptions.maxRetries) {
                      setTimeout(() => retry(message, metadata), retryOptions.delayFunction(retries));
                    } else {
                      savedMessageNext(savedReceiveMessage);
                      next(status);
                    }
                  } else {
                    savedMessageNext(savedReceiveMessage);
                    next({ code: grpc.status.OK, details: '', metadata: new Metadata() });
                  }
                },
              });
              newCall.sendMessage(message);
              newCall.halfClose();
            };

            if (isRetryableError(status)) {
              setTimeout(() => retry(savedSendMessage, savedMetadata), backOffAmount(retries));
            } else {
              savedMessageNext(savedReceiveMessage);
              next(status);
            }
          })
          .build();
        next(metadata, newListener);
      })
      .withSendMessage((message, next) => {
        savedSendMessage = message;
        next(message);
      })
      .build();
    return new InterceptingCall(nextCall(options), requester);
  };
}
