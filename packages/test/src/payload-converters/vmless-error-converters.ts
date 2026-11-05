import {
  ApplicationFailure,
  defaultFailureConverter,
  defaultPayloadConverter,
  type FailureConverter,
  type PayloadConverter,
  type Payload,
  type SerializationContext,
} from '@temporalio/common';
import { getActivator } from '@temporalio/workflow/internal';

export const payloadConverter: PayloadConverter = {
  toPayload(value, context) {
    if (value === 'fail-payload') throw new Error('payload conversion failed');
    if (value === 'fail-payload-undefined') throw undefined;
    return defaultPayloadConverter.toPayload(value, context);
  },
  fromPayload<T>(payload: Payload, context?: SerializationContext): T {
    const value = defaultPayloadConverter.fromPayload<T>(payload, context);
    if (value === 'fail-input') throw ApplicationFailure.nonRetryable('convert-failure:input');
    return value;
  },
};

export const failureConverter: FailureConverter = {
  errorToFailure(error, converter, context) {
    if (error instanceof Error && error.message.startsWith('convert-failure:')) {
      throw new Error(`failure conversion failed:${error.message.slice('convert-failure:'.length)}`);
    }
    // The final observer must run after handler bookkeeping has been cleaned up.
    const activator = getActivator();
    if (
      !(error instanceof ApplicationFailure) &&
      (activator.inProgressSignals.size || activator.inProgressUpdates.size)
    ) {
      throw new Error('SDK handler cleanup was incomplete');
    }
    return defaultFailureConverter.errorToFailure(error, converter, context);
  },
  failureToError: defaultFailureConverter.failureToError.bind(defaultFailureConverter),
};
