import * as nexus from 'nexus-rpc';
import type { Payload, PayloadConverter } from '@temporalio/common';
import { defaultPayloadConverter } from '@temporalio/common';

export const payloadConverter: PayloadConverter = {
  toPayload<T>(value: T): Payload {
    return defaultPayloadConverter.toPayload(value);
  },
  fromPayload<T>(_payload: Payload): T {
    throw new nexus.HandlerError('NOT_FOUND', 'Intentional payload converter HandlerError for testing', {
      retryableOverride: false,
    });
  },
};
