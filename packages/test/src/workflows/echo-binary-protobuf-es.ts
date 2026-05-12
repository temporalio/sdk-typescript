import { ApplicationFailure } from '@temporalio/common';
import type { BinaryMessage } from '../protos-es-gen/messages_pb';

export async function echoBinaryProtobufEs(input: BinaryMessage): Promise<BinaryMessage> {
  if (input.data instanceof Uint8Array) {
    return input;
  }
  throw ApplicationFailure.nonRetryable('input.data is not a Uint8Array');
}
