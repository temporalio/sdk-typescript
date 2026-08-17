import type { Payload } from '@temporalio/common';
import { ApplicationFailure, defaultPayloadConverter } from '@temporalio/common';
import type { PayloadConverter } from '@temporalio/common/lib/converter/payload-converter';

export const payloadConverter: PayloadConverter = {
  toPayload<T>(value: T): Payload {
    return defaultPayloadConverter.toPayload(value);
  },
  fromPayload<T>(_payload: Payload): T {
    // The reserved type a converter uses to report that it understood the payload but rejects it.
    throw ApplicationFailure.create({
      message: 'Intentional payload validation failure for testing',
      type: 'PayloadValidationError',
      nonRetryable: true,
    });
  },
};
