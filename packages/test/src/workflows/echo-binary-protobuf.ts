import type { BinaryMessage } from '../../protos/root';
import { ApplicationFailure } from '@temporalio/common';
export async function echoBinaryProtobuf(input: BinaryMessage): Promise<BinaryMessage> {
  if (input.data instanceof Uint8Array) {
    return input;
  }
  throw ApplicationFailure.nonRetryable('input.data is not a Uint8Array');
}
