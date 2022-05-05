import {
  errorMessage,
  PayloadConverterError,
  UnsupportedTypeError,
  ValueError,
} from '@temporalio/internal-workflow-common';
import { PayloadConverter } from './payload-converter';
import { encodingKeys, encodingTypes, METADATA_ENCODING_KEY, Payload, str, u8 } from './types';

export interface PayloadConverterWithEncoding extends PayloadConverter {
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
   * Returns the first successful result, or `undefined` if there is no converter that can handle the value.
   *
   * @throws {@link ValueError}
   */
  public toPayload<T>(value: T): Payload {
    let lastError: unknown;
    for (const converter of this.converters) {
      try {
        return converter.toPayload(value);
      } catch (e) {
        lastError = e;
      }
    }

    throw new ValueError(
      `Unable to serialize value: ${value} of type ${typeof value}. None of the configured \`PayloadConverter\`s support converting this value to a Payload. Either use serializable values or create a custom data converter: https://docs.temporal.io/docs/typescript/data-converters . The last \`PayloadConverter\`'s error was: ${errorMessage(
        lastError
      )}`,
      lastError
    );
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

  public toPayload(value: unknown): Payload {
    if (value !== undefined)
      throw new UnsupportedTypeError(
        `UndefinedPayloadConverter can only convert undefined. Received value: ${value} of type ${typeof value}.`
      );
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
 */
export class JsonPayloadConverter implements PayloadConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_JSON;

  /*
   * @throws {@link UnsupportedTypeError}
   */
  public toPayload(value: unknown): Payload {
    if (value === undefined) throw new UnsupportedTypeError(`JsonPayloadConverter can't convert undefined.`);

    let json;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      throw new UnsupportedTypeError(
        `Can't run JSON.stringify on this value: ${value}. Either convert it (or its properties) to JSON-serializable values (see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#description ), or use a custom data converter: https://docs.temporal.io/docs/typescript/data-converters . JSON.stringify error message: ${errorMessage(
          e
        )}`,
        e
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

  public toPayload(value: unknown): Payload {
    // TODO: support any DataView or ArrayBuffer?
    if (!(value instanceof Uint8Array))
      throw new UnsupportedTypeError(
        `BinaryPayloadConverter can only convert \`Uint8Array\`s. Received value: ${value} of type ${typeof value}.`
      );

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

export const searchAttributePayloadConverter = new JsonPayloadConverter();

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
 * The default {@link PayloadConverter} used by the SDK.
 * Supports `Uint8Array` and JSON serializables (so if [`JSON.stringify(yourArgOrRetval)`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#description) works, the default payload converter will work).
 *
 * To also support Protobufs, create a custom payload converter with {@link DefaultPayloadConverter}:
 *
 * `const myConverter = new DefaultPayloadConverter({ protobufRoot })`
 */
export const defaultPayloadConverter = new DefaultPayloadConverter();
