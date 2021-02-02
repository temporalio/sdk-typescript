import '@temporal-sdk/workflow';

export function str(a: Uint8Array): string {
  let out = '';
  for (const c of a) {
    out += String.fromCharCode(c);
  }
  return out;
}

export async function main(greeting: string, _skip: undefined, arr: ArrayBuffer) {
  const name = str(new Uint8Array(arr));
  return `${greeting}, ${name}`;
}
