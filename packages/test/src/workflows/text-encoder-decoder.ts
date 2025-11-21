import { TextEncoder as TextEncoderFromImport, TextDecoder as TextDecoderFromImport } from 'util';

export async function textEncoderDecoder(text: string): Promise<string> {
  // we don't import these - they are exposed as globals
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const encoded = encoder.encode(text);
  const decoded = decoder.decode(encoded);
  return decoded;
}

export async function textEncoderDecoderFromImport(text: string): Promise<string> {
  const encoder = new TextEncoderFromImport();
  const decoder = new TextDecoderFromImport();
  const encoded = encoder.encode(text);
  const decoded = decoder.decode(encoded);
  return decoded;
}
