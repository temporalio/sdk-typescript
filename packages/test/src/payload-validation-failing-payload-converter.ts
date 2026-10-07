import type { Payload, PayloadConverter } from '@temporalio/common';
import { createPayloadValidationError, defaultPayloadConverter } from '@temporalio/common';

export const payloadConverter: PayloadConverter = {
  toPayload<T>(value: T): Payload {
    return defaultPayloadConverter.toPayload(value);
  },
  fromPayload<T>(_payload: Payload): T {
    throw createPayloadValidationError({
      violations: [{ path: 'input', reason: 'intentional payload validation failure for testing' }],
    });
  },
};
