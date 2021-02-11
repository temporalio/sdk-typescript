export function u8(s: string): Uint8Array {
  // TextEncoder requires lib "dom"
  // @ts-ignore
  return new TextEncoder().encode(s);
}
