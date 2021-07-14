import { u8, str, Payload, encodingTypes, encodingKeys, METADATA_ENCODING_KEY, ValueError } from './types';

/**
 * Used by the framework to serialize/deserialize method parameters that need to be sent over the
 * wire.
 *
 * @author fateev
 */
export interface PayloadConverter {
  encodingType: string;

  /**
   * TODO: Fix comment in https://github.com/temporalio/sdk-java/blob/85593dbfa99bddcdf54c7196d2b73eeb23e94e9e/temporal-sdk/src/main/java/io/temporal/common/converter/DataConverter.java#L46
   * Implements conversion of value to payload
   *
   * @param value JS value to convert.
   * @return converted value
   * @throws DataConverterException if conversion of the value passed as parameter failed for any
   *     reason.
   */
  toData(value: unknown): Promise<Payload | undefined>;

  /**
   * Implements conversion of payload to value.
   *
   * @param content Serialized value to convert to a JS value.
   * @return converted JS value
   * @throws DataConverterException if conversion of the data passed as parameter failed for any
   *     reason.
   */
  fromData<T>(content: Payload): Promise<T>;
}

/**
 * Converts between JS undefined and NULL Payload
 */
export class UndefinedPayloadConverter implements PayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_NULL;

  public async toData(value: unknown): Promise<Payload | undefined> {
    if (value !== undefined) return undefined; // Can't encode
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_NULL,
      },
    };
  }

  public async fromData<T>(_content: Payload): Promise<T> {
    return undefined as any; // Just return undefined
  }
}

/**
 * Converts between non-undefined values and serialized JSON Payload
 */
export class JsonPayloadConverter implements PayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_JSON;

  public async toData(value: unknown): Promise<Payload | undefined> {
    if (value === undefined) return undefined; // Should be encoded with the UndefinedPayloadConverter
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON,
      },
      data: u8(JSON.stringify(value)),
    };
  }

  public async fromData<T>(content: Payload): Promise<T> {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    return JSON.parse(str(content.data));
  }
}

/**
 * Converts between binary data types and RAW Payload
 */
export class BinaryPayloadConverter implements PayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_RAW;

  public async toData(value: unknown): Promise<Payload | undefined> {
    // TODO: support any DataView or ArrayBuffer?
    if (!(value instanceof Uint8Array)) {
      return undefined;
    }
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW,
      },
      data: value,
    };
  }

  public async fromData<T>(content: Payload): Promise<T> {
    // TODO: support any DataView or ArrayBuffer?
    return content.data as any;
  }
}
