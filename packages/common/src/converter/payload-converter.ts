import { decode, encode } from '../encoding';
import { PayloadConverterError, ValueError } from '../errors';
import { Payload } from '../interfaces';
import { encodingKeys, encodingTypes, METADATA_ENCODING_KEY } from './types';

/**
 * Used by the framework to serialize/deserialize data like parameters and return values.
 *
 * This is called inside the {@link https://docs.temporal.io/typescript/determinism | Workflow isolate}.
 * To write async code or use Node APIs (or use packages that use Node APIs), use a {@link PayloadCodec}.
 */
export interface PayloadConverter {
  /**
   * Converts a value to a {@link Payload}.
   *
   * @param value The value to convert. Example values include the Workflow args sent from the Client and the values returned by a Workflow or Activity.
   *
   * @returns The {@link Payload}.
   *
   * Should throw {@link ValueError} if unable to convert.
   */
  toPayload<T>(value: T): Payload;

  /**
   * Converts a {@link Payload} back to a value.
   */
  fromPayload<T>(payload: Payload): T;
}

/**
 * Implements conversion of a list of values.
 *
 * @param converter
 * @param values JS values to convert to Payloads
 * @return list of {@link Payload}s
 * @throws {@link ValueError} if conversion of the value passed as parameter failed for any
 *     reason.
 */
export function toPayloads(converter: PayloadConverter, ...values: unknown[]): Payload[] | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return values.map((value) => converter.toPayload(value));
}

/**
 * Run {@link PayloadConverter.toPayload} on each value in the map.
 *
 * @throws {@link ValueError} if conversion of any value in the map fails
 */
export function mapToPayloads<K extends string>(converter: PayloadConverter, map: Record<K, any>): Record<K, Payload> {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]): [K, Payload] => [k as K, converter.toPayload(v)])
  ) as Record<K, Payload>;
}

/**
 * Implements conversion of an array of values of different types. Useful for deserializing
 * arguments of function invocations.
 *
 * @param converter
 * @param index index of the value in the payloads
 * @param payloads serialized value to convert to JS values.
 * @return converted JS value
 * @throws {@link PayloadConverterError} if conversion of the data passed as parameter failed for any
 *     reason.
 */
export function fromPayloadsAtIndex<T>(converter: PayloadConverter, index: number, payloads?: Payload[] | null): T {
  // To make adding arguments a backwards compatible change
  if (payloads === undefined || payloads === null || index >= payloads.length) {
    return undefined as any;
  }
  return converter.fromPayload(payloads[index]);
}

/**
 * Run {@link PayloadConverter.fromPayload} on each value in the array.
 */
export function arrayFromPayloads(converter: PayloadConverter, payloads?: Payload[] | null): unknown[] {
  if (!payloads) {
    return [];
  }
  return payloads.map((payload: Payload) => converter.fromPayload(payload));
}

export function mapFromPayloads<K extends string>(
  converter: PayloadConverter,
  map?: Record<K, Payload> | null | undefined
): Record<K, unknown> | undefined {
  if (map == null) return undefined;
  return Object.fromEntries(
    Object.entries(map).map(([k, payload]): [K, unknown] => {
      const value = converter.fromPayload(payload as Payload);
      return [k as K, value];
    })
  ) as Record<K, unknown>;
}

export interface PayloadConverterWithEncoding {
  /**
   * Converts a value to a {@link Payload}.
   *
   * @param value The value to convert. Example values include the Workflow args sent from the Client and the values returned by a Workflow or Activity.
   * @returns The {@link Payload}, or `undefined` if unable to convert.
   */
  toPayload<T>(value: T): Payload | undefined;

  /**
   * Converts a {@link Payload} back to a value.
   */
  fromPayload<T>(payload: Payload): T;

  readonly encodingType: string;
}

/**
 * Tries to convert values to {@link Payload}s using the {@link PayloadConverterWithEncoding}s provided to the constructor, in the order provided.
 *
 * Converts Payloads to values based on the `Payload.metadata.encoding` field, which matches the {@link PayloadConverterWithEncoding.encodingType}
 * of the converter that created the Payload.
 */
export class CompositePayloadConverter implements PayloadConverter {
  readonly converters: PayloadConverterWithEncoding[];
  readonly converterByEncoding: Map<string, PayloadConverterWithEncoding> = new Map();

  constructor(...converters: PayloadConverterWithEncoding[]) {
    if (converters.length === 0) {
      throw new PayloadConverterError('Must provide at least one PayloadConverterWithEncoding');
    }

    this.converters = converters;
    for (const converter of converters) {
      this.converterByEncoding.set(converter.encodingType, converter);
    }
  }

  /**
   * Tries to run `.toPayload(value)` on each converter in the order provided at construction.
   * Returns the first successful result, throws {@link ValueError} if there is no converter that can handle the value.
   */
  public toPayload<T>(value: T): Payload {
    for (const converter of this.converters) {
      const result = converter.toPayload(value);
      if (result !== undefined) {
        return result;
      }
    }

    throw new ValueError(`Unable to convert ${value} to payload`);
  }

  /**
   * Run {@link PayloadConverterWithEncoding.fromPayload} based on the `encoding` metadata of the {@link Payload}.
   */
  public fromPayload<T>(payload: Payload): T {
    if (payload.metadata === undefined || payload.metadata === null) {
      throw new ValueError('Missing payload metadata');
    }
    const encoding = decode(payload.metadata[METADATA_ENCODING_KEY]);
    const converter = this.converterByEncoding.get(encoding);
    if (converter === undefined) {
      throw new ValueError(`Unknown encoding: ${encoding}`);
    }
    return converter.fromPayload(payload);
  }
}

/**
 * Converts between JS undefined and NULL Payload
 */
export class UndefinedPayloadConverter implements PayloadConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_NULL;

  public toPayload(value: unknown): Payload | undefined {
    if (value !== undefined) {
      return undefined;
    }

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
 * Converts between binary data types and RAW Payload
 */
export class BinaryPayloadConverter implements PayloadConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_RAW;

  public toPayload(value: unknown): Payload | undefined {
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

  public fromPayload<T>(content: Payload): T {
    return (
      // Wrap with Uint8Array from this context to ensure `instanceof` works
      (
        content.data ? new Uint8Array(content.data.buffer, content.data.byteOffset, content.data.length) : content.data
      ) as any
    );
  }
}

/**
 * Converts between non-undefined values and serialized JSON Payload
 */
export class JsonPayloadConverter implements PayloadConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_JSON;

  public toPayload(value: unknown): Payload | undefined {
    if (value === undefined) {
      return undefined;
    }

    let json;
    try {
      json = JSON.stringify(value);
    } catch (_err) {
      return undefined;
    }

    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON,
      },
      data: encode(json),
    };
  }

  public fromPayload<T>(content: Payload): T {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    return JSON.parse(decode(content.data));
  }
}

/**
 * Converts Search Attribute values using JsonPayloadConverter
 */
export class SearchAttributePayloadConverter implements PayloadConverter {
  jsonConverter = new JsonPayloadConverter();
  validNonDateTypes = ['string', 'number', 'boolean'];

  public toPayload(values: unknown): Payload {
    if (!Array.isArray(values)) {
      throw new ValueError(`SearchAttribute value must be an array`);
    }

    if (values.length > 0) {
      const firstValue = values[0];
      const firstType = typeof firstValue;
      if (firstType === 'object') {
        for (const [idx, value] of values.entries()) {
          if (!(value instanceof Date)) {
            throw new ValueError(
              `SearchAttribute values must arrays of strings, numbers, booleans, or Dates. The value ${value} at index ${idx} is of type ${typeof value}`
            );
          }
        }
      } else {
        if (!this.validNonDateTypes.includes(firstType)) {
          throw new ValueError(`SearchAttribute array values must be: string | number | boolean | Date`);
        }

        for (const [idx, value] of values.entries()) {
          if (typeof value !== firstType) {
            throw new ValueError(
              `All SearchAttribute array values must be of the same type. The first value ${firstValue} of type ${firstType} doesn't match value ${value} of type ${typeof value} at index ${idx}`
            );
          }
        }
      }
    }

    // JSON.stringify takes care of converting Dates to ISO strings
    const ret = this.jsonConverter.toPayload(values);
    if (ret === undefined) {
      throw new ValueError('Could not convert search attributes to payloads');
    }
    return ret;
  }

  /**
   * Datetime Search Attribute values are converted to `Date`s
   */
  public fromPayload<T>(payload: Payload): T {
    if (payload.metadata === undefined || payload.metadata === null) {
      throw new ValueError('Missing payload metadata');
    }

    const value = this.jsonConverter.fromPayload(payload);
    let arrayWrappedValue = Array.isArray(value) ? value : [value];

    const searchAttributeType = decode(payload.metadata.type);
    if (searchAttributeType === 'Datetime') {
      arrayWrappedValue = arrayWrappedValue.map((dateString) => new Date(dateString));
    }
    return arrayWrappedValue as unknown as T;
  }
}

export const searchAttributePayloadConverter = new SearchAttributePayloadConverter();

export class DefaultPayloadConverter extends CompositePayloadConverter {
  // Match the order used in other SDKs, but exclude Protobuf converters so that the code, including
  // `proto3-json-serializer`, doesn't take space in Workflow bundles that don't use Protobufs. To use Protobufs, use
  // {@link DefaultPayloadConverterWithProtobufs}.
  //
  // Go SDK:
  // https://github.com/temporalio/sdk-go/blob/5e5645f0c550dcf717c095ae32c76a7087d2e985/converter/default_data_converter.go#L28
  constructor() {
    super(new UndefinedPayloadConverter(), new BinaryPayloadConverter(), new JsonPayloadConverter());
  }
}

/**
 * The default {@link PayloadConverter} used by the SDK. Supports `Uint8Array` and JSON serializables (so if
 * {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#description | `JSON.stringify(yourArgOrRetval)`}
 * works, the default payload converter will work).
 *
 * To also support Protobufs, create a custom payload converter with {@link DefaultPayloadConverter}:
 *
 * `const myConverter = new DefaultPayloadConverter({ protobufRoot })`
 */
export const defaultPayloadConverter = new DefaultPayloadConverter();
