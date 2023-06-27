import { decode } from '@temporalio/common/lib/encoding';
import { ApplicationFailure } from '@temporalio/workflow';

export async function argsAndReturn(greeting: string, _skip: undefined, arr: Uint8Array): Promise<string> {
  if (!(arr instanceof Uint8Array)) {
    throw ApplicationFailure.nonRetryable('Uint8Array not wrapped');
  }
  const name = decode(arr);
  return `${greeting}, ${name}`;
}
