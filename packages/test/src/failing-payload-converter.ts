import type { Payload, PayloadConverter } from '@temporalio/common';
import { defaultPayloadConverter } from '@temporalio/common';

export const payloadConverter: PayloadConverter = {
  toPayload<T>(value: T): Payload {
    return defaultPayloadConverter.toPayload(value);
  },
  fromPayload<T>(_payload: Payload): T {
    throw new Error('Intentional payload converter failure for testing');
  },
};
