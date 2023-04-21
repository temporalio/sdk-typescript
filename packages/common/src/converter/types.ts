import { encode } from '../encoding';

export const METADATA_ENCODING_KEY = 'encoding';
export const encodingTypes = {
  METADATA_ENCODING_NULL: 'binary/null',
  METADATA_ENCODING_RAW: 'binary/plain',
  METADATA_ENCODING_JSON: 'json/plain',
  METADATA_ENCODING_PROTOBUF_JSON: 'json/protobuf',
  METADATA_ENCODING_PROTOBUF: 'binary/protobuf',
} as const;
export type EncodingType = (typeof encodingTypes)[keyof typeof encodingTypes];

export const encodingKeys = {
  METADATA_ENCODING_NULL: encode(encodingTypes.METADATA_ENCODING_NULL),
  METADATA_ENCODING_RAW: encode(encodingTypes.METADATA_ENCODING_RAW),
  METADATA_ENCODING_JSON: encode(encodingTypes.METADATA_ENCODING_JSON),
  METADATA_ENCODING_PROTOBUF_JSON: encode(encodingTypes.METADATA_ENCODING_PROTOBUF_JSON),
  METADATA_ENCODING_PROTOBUF: encode(encodingTypes.METADATA_ENCODING_PROTOBUF),
} as const;

export const METADATA_MESSAGE_TYPE_KEY = 'messageType';
