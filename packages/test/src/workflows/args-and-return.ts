import { decode } from '@temporalio/common/lib/encoding';

export async function argsAndReturn(greeting: string, _skip: undefined, arr: ArrayBuffer): Promise<string> {
  const name = decode(new Uint8Array(arr));
  return `${greeting}, ${name}`;
}
