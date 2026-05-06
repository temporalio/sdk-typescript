import type { Payload } from '@temporalio/common';
import { defaultPayloadConverter } from '@temporalio/common';
import type { PayloadConverter } from '@temporalio/common/lib/converter/payload-converter';

export const payloadConverter: PayloadConverter = {
  toPayload<T>(value: T): Payload {
    return defaultPayloadConverter.toPayload(value);
  },
  fromPayload<T>(_payload: Payload): T {
    throw new Error('Intentional payload converter failure for testing');
  },
};
