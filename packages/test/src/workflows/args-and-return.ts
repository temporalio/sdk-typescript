import { ApplicationFailure } from '@temporalio/workflow';

export async function argsAndReturn(greeting: string, _skip: undefined, arr: Uint8Array): Promise<string> {
  if (!(arr instanceof Uint8Array)) {
    throw ApplicationFailure.nonRetryable('Uint8Array not wrapped');
  }
  if (Buffer.alloc !== Buffer.allocUnsafe) {
    throw ApplicationFailure.nonRetryable('Injected Buffer object not made safe');
  }
  const name = Buffer.from(arr).toString();
  return `${greeting}, ${name}`;
}
