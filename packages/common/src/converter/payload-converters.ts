import { errorMessage, UnsupportedJsonTypeError, ValueError } from '@temporalio/internal-workflow-common';
import { PayloadConverter } from './payload-converter';
import { encodingKeys, EncodingType, encodingTypes, METADATA_ENCODING_KEY, Payload, str, u8 } from './types';

export interface PayloadConverterWithEncoding extends PayloadConverter {
  readonly encodingType: EncodingType;
}

/**
 * Converts between JS undefined and NULL Payload
 */
export class UndefinedPayloadConverter implements PayloadConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_NULL;

  public toPayload(value: unknown): Payload | undefined {
    if (value !== undefined) return undefined; // Can't encode
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_NULL,
      },
    };
  }

  public fromPayload<T>(_content: Payload): T {
    return undefined as any; // Just return undefined
  }
}

/**
 * Converts between non-undefined values and serialized JSON Payload
 *
 * @throws UnsupportedJsonTypeError
 */
export class JsonPayloadConverter implements PayloadConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_JSON;

  public toPayload(value: unknown): Payload | undefined {
    if (value === undefined) return undefined;

    let json;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      throw new UnsupportedJsonTypeError(
        `Can't run JSON.stringify on this value: ${value}. Either convert it (or its properties) to JSON-serializable values (see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#description ), or use a custom data converter: https://docs.temporal.io/docs/typescript/data-converters . JSON.stringify error message: ${errorMessage(
          e
        )}`,
        e as Error
      );
    }

    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON,
      },
      data: u8(json),
    };
  }

  public fromPayload<T>(content: Payload): T {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    return JSON.parse(str(content.data));
  }
}

/**
 * Converts between binary data types and RAW Payload
 */
export class BinaryPayloadConverter implements PayloadConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_RAW;

  public toPayload(value: unknown): Payload | undefined {
    // TODO: support any DataView or ArrayBuffer?
    if (!(value instanceof Uint8Array)) return undefined;
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW,
      },
      data: value,
    };
  }

  public fromPayload<T>(content: Payload): T {
    // TODO: support any DataView or ArrayBuffer?
    return content.data as any;
  }
}
