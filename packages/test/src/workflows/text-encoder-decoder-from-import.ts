import { TextEncoder, TextDecoder } from 'util';

export async function textEncoderDecoderFromImport(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const encoded = encoder.encode(text);
  const decoded = decoder.decode(encoded);
  return decoded;
}
