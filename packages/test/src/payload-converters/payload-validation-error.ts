import type { Payload, PayloadConverter, SerializationContext } from '@temporalio/common';
import { createPayloadValidationError, defaultPayloadConverter } from '@temporalio/common';

export const payloadConverter: PayloadConverter = {
  toPayload(value: any, context?: SerializationContext): Payload {
    if (typeof value === 'string' && value === 'invalid-payload') {
      throw createPayloadValidationError({ stage: 'toPayload' });
    }
    return defaultPayloadConverter.toPayload(value, context);
  },
  fromPayload<T>(payload: Payload, context?: SerializationContext): T {
    const value = defaultPayloadConverter.fromPayload<any>(payload, context);
    if (typeof value === 'string' && value === 'invalid-payload') {
      throw createPayloadValidationError({ stage: 'fromPayload' });
    }
    return value;
  },
};
