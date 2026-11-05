import {
  defaultFailureConverter,
  defaultPayloadConverter,
  type FailureConverter,
  type PayloadConverter,
} from '@temporalio/common';
import { inWorkflowContext, workflowInfo } from '@temporalio/workflow';

const importedRunId = inWorkflowContext() ? workflowInfo().runId : undefined;

function checkOwnership(): void {
  if (importedRunId !== undefined && workflowInfo().runId !== importedRunId) {
    throw new Error('Converter execution ownership changed');
  }
}

export const payloadConverter: PayloadConverter = {
  toPayload(value, context) {
    checkOwnership();
    return defaultPayloadConverter.toPayload(value, context);
  },
  fromPayload(value, context) {
    checkOwnership();
    return defaultPayloadConverter.fromPayload(value, context);
  },
};

export const failureConverter: FailureConverter = {
  errorToFailure(error, converter, context) {
    checkOwnership();
    const failure = defaultFailureConverter.errorToFailure(error, converter, context);
    return importedRunId === undefined
      ? failure
      : { ...failure, message: `${workflowInfo().runId}:${failure.message}` };
  },
  failureToError(failure, converter, context) {
    checkOwnership();
    return defaultFailureConverter.failureToError(failure, converter, context);
  },
};
