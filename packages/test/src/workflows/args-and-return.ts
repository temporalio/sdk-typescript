import { str } from '@temporalio/common';

export async function argsAndReturn(greeting: string, _skip: undefined, arr: ArrayBuffer): Promise<string> {
  const name = str(new Uint8Array(arr));
  return `${greeting}, ${name}`;
}
