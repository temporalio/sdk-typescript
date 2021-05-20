import '@temporalio/workflow';
import { ArgsAndReturn } from '../interfaces';

export function str(a: Uint8Array): string {
  let out = '';
  for (const c of a) {
    out += String.fromCharCode(c);
  }
  return out;
}

async function main(greeting: string, _skip: undefined, arr: ArrayBuffer): Promise<string> {
  const name = str(new Uint8Array(arr));
  return `${greeting}, ${name}`;
}

export const workflow: ArgsAndReturn = { main };
