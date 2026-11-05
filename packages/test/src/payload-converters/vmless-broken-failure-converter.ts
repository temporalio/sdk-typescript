import { defaultFailureConverter, type FailureConverter } from '@temporalio/common';

export const failureConverter: FailureConverter = {
  errorToFailure() {
    throw new Error('failure converter is broken');
  },
  failureToError: defaultFailureConverter.failureToError.bind(defaultFailureConverter),
};
