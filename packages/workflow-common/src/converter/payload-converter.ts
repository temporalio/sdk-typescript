import { UnsupportedTypeError, ValueError } from '../errors';
import {
  BinaryPayloadConverter,
  JsonPayloadConverter,
  PayloadConverterWithEncoding,
  ProtobufBinaryPayloadConverter,
  ProtobufJsonPayloadConverter,
  UndefinedPayloadConverter,
} from './payload-converters';
import { METADATA_ENCODING_KEY, Payload, str } from './types';

/**
 * Used by the framework to serialize/deserialize parameters and return values that need to be
 * sent over the wire.
 *
 * This is called inside the [Workflow isolate](https://docs.temporal.io/docs/typescript/determinism).
 * To write async code or use Node APIs (or use packages that use Node APIs), use a {@link PayloadCodec}.
 */
export interface PayloadConverter {
  /**
   * Converts a value to a {@link Payload}.
   * @param value The value to convert. Example values include the Workflow args sent by the client and the values returned by a Workflow or Activity.
   */
  toPayload<T>(value: T): Payload;

  /**
   * Converts a {@link Payload} back to a value.
   */
  fromPayload<T>(payload: Payload): T;
}

export class CompositePayloadConverter implements PayloadConverter {
  readonly converters: PayloadConverterWithEncoding[];
  readonly converterByEncoding: Map<string, PayloadConverterWithEncoding> = new Map();

  constructor(...converters: PayloadConverterWithEncoding[]) {
    this.converters = converters;
    for (const converter of converters) {
      this.converterByEncoding.set(converter.encodingType, converter);
    }
  }

  /**
   * Tries to run `.toPayload(value)` on each converter in the order provided at construction.
   * Returns the first successful result.
   * @throws {@link ValueError} if no converter can convert the value
   */
  public toPayload<T>(value: T): Payload {
    for (const converter of this.converters) {
      try {
        const result = converter.toPayload(value);
        return result;
      } catch (e: unknown) {
        if (e instanceof UnsupportedTypeError) {
          continue;
        } else {
          throw e;
        }
      }
    }
    throw new ValueError(`Cannot serialize ${value}`);
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
 * Implements conversion of a list of values.
 *
 * @param converter
 * @param values JS values to convert to Payloads.
 * @return converted value
 * @throws PayloadConverterError if conversion of the value passed as parameter failed for any
 *     reason.
 */
export function toPayloads(converter: PayloadConverter, ...values: unknown[]): Payload[] | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.map((value) => converter.toPayload(value));
}

/**
 * Implements conversion of an array of values of different types. Useful for deserializing
 * arguments of function invocations.
 *
 * @param converter
 * @param index index of the value in the payloads
 * @param payloads serialized value to convert to JS values.
 * @return converted JS value
 * @throws PayloadConverterError if conversion of the data passed as parameter failed for any
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

/**
 * Run {@link PayloadConverter.toPayload} on each value in the map.
 */
export function mapToPayloads<K extends string>(converter: PayloadConverter, map: Record<K, any>): Record<K, Payload> {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]): [K, Payload] => [k as K, converter.toPayload(v)])
  ) as Record<K, Payload>;
}

export interface DefaultPayloadConverterOptions {
  /**
   * The `root` provided to {@link ProtobufJsonPayloadConverter} and {@link ProtobufBinaryPayloadConverter}
   */
  protobufRoot?: Record<string, unknown>;
}

export class DefaultPayloadConverter extends CompositePayloadConverter {
  constructor({ protobufRoot }: DefaultPayloadConverterOptions = {}) {
    // Match the order used in other SDKs
    // Go SDK: https://github.com/temporalio/sdk-go/blob/5e5645f0c550dcf717c095ae32c76a7087d2e985/converter/default_data_converter.go#L28
    super(
      new UndefinedPayloadConverter(),
      new BinaryPayloadConverter(),
      new ProtobufJsonPayloadConverter(protobufRoot),
      new ProtobufBinaryPayloadConverter(protobufRoot),
      new JsonPayloadConverter()
    );
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
