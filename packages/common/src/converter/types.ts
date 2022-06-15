import { TextDecoder, TextEncoder } from './encoding';

export { Payload } from '@temporalio/internal-workflow-common';

/**
 * Transform an *ascii* string into a Uint8Array
 */
export function u8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function str(a: Uint8Array): string {
  return new TextDecoder().decode(a);
}

export const METADATA_ENCODING_KEY = 'encoding';
export const encodingTypes = {
  METADATA_ENCODING_NULL: 'binary/null',
  METADATA_ENCODING_RAW: 'binary/plain',
  METADATA_ENCODING_JSON: 'json/plain',
  METADATA_ENCODING_PROTOBUF_JSON: 'json/protobuf',
  METADATA_ENCODING_PROTOBUF: 'binary/protobuf',
} as const;
export type EncodingType = typeof encodingTypes[keyof typeof encodingTypes];

export const encodingKeys = {
  METADATA_ENCODING_NULL: u8(encodingTypes.METADATA_ENCODING_NULL),
  METADATA_ENCODING_RAW: u8(encodingTypes.METADATA_ENCODING_RAW),
  METADATA_ENCODING_JSON: u8(encodingTypes.METADATA_ENCODING_JSON),
  METADATA_ENCODING_PROTOBUF_JSON: u8(encodingTypes.METADATA_ENCODING_PROTOBUF_JSON),
  METADATA_ENCODING_PROTOBUF: u8(encodingTypes.METADATA_ENCODING_PROTOBUF),
} as const;

export const METADATA_MESSAGE_TYPE_KEY = 'messageType';
