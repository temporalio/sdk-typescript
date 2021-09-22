import { InterceptingCall, Interceptor, ListenerBuilder, Metadata, RequesterBuilder } from '@grpc/grpc-js';
import * as grpc from '@grpc/grpc-js';

const maxRetries = 3;

export const GrpcRetry: Interceptor = (options, nextCall) => {
  let savedMetadata: Metadata;
  let savedSendMessage: any;
  let savedReceiveMessage: any;
  let savedMessageNext: any;
  const requester = new RequesterBuilder()
    .withStart(function (metadata, listener, next) {
      savedMetadata = metadata;
      const newListener = new ListenerBuilder()
        .withOnReceiveMessage(function (message, next) {
          savedReceiveMessage = message;
          savedMessageNext = next;
        })
        .withOnReceiveStatus(function (status, next) {
          let retries = 0;
          const retry = function (message: any, metadata: Metadata) {
            retries++;
            const newCall = nextCall(options);
            newCall.start(metadata, {
              onReceiveMessage: function (message) {
                savedReceiveMessage = message;
              },
              onReceiveStatus: function (status) {
                if (status.code !== grpc.status.OK) {
                  if (retries <= maxRetries) {
                    retry(message, metadata);
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
          };
          if (status.code !== grpc.status.OK) {
            retry(savedSendMessage, savedMetadata);
          } else {
            savedMessageNext(savedReceiveMessage);
            next(status);
          }
        })
        .build();
      next(metadata, newListener);
    })
    .withSendMessage(function (message, next) {
      savedSendMessage = message;
      next(message);
    })
    .build();
  return new InterceptingCall(nextCall(options), requester);
};
