import type { coresdk } from '@temporalio/proto/lib/coresdk';
import { TextDecoder, TextEncoder } from './encoding';

export type Payload = coresdk.common.IPayload;

export interface EncodedPayload extends Payload {
  encoded: true;
}

/** An object T with any nested values of type ToReplace replaced with ReplaceWith */
export type ReplaceNested<T, ToReplace, ReplaceWith> = T extends (...args: any[]) => any
  ? T
  : T extends { [k: string]: coresdk.common.IPayload } | null
  ? {
      [P in keyof T]: ReplaceNested<T[P], ToReplace, ReplaceWith>;
    }
  : T extends ToReplace
  ? ReplaceWith | Exclude<T, ToReplace>
  : {
      [P in keyof T]: ReplaceNested<T[P], ToReplace, ReplaceWith>;
    };

/** Replace `Payload`s with `EncodedPayload`s */
export type Encoded<T> = ReplaceNested<T, Payload, EncodedPayload>;

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
