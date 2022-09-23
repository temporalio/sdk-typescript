import { PayloadConverterError, ValueError } from '../errors';
import { Payload } from '../interfaces';
import { JsonPayloadConverter } from './json-payload-converter';
import { PayloadConverter } from './payload-converter';
import { SearchAttributePayloadConverter } from './search-attribute-payload-converter';
import { encodingKeys, encodingTypes, METADATA_ENCODING_KEY, str } from './types';

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
   * Run {@link PayloadConverterWithEncoding.fromPayload} based on the {@link encodingTypes | encoding type} of the {@link Payload}.
   */
  public fromPayload<T>(payload: Payload): T {
    if (payload.metadata === undefined || payload.metadata === null) {
      throw new ValueError('Missing payload metadata');
    }
    const encoding = str(payload.metadata[METADATA_ENCODING_KEY]);
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
    return content.data as any;
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
