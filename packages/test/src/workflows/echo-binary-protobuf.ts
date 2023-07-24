import { ApplicationFailure } from '@temporalio/common';
import type { BinaryMessage } from '../../protos/root';

export async function echoBinaryProtobuf(input: BinaryMessage): Promise<BinaryMessage> {
  if (input.data instanceof Uint8Array) {
    return input;
  }
  throw ApplicationFailure.nonRetryable('input.data is not a Uint8Array');
}
