import { DataConverterError } from '@temporalio/workflow-common';

function throwError(): void {
  throw new DataConverterError('In order to JSON-encode/decode protobufs, specify a `WorkerOptions.dataConverter`');
}

export const toProto3JSON = throwError;
export const fromProto3JSON = throwError;
