import { str, METADATA_ENCODING_KEY, Payload, Payloads, ValueError } from './types';
import {
  PayloadConverter,
  UndefinedPayloadConverter,
  BinaryPayloadConverter,
  JsonPayloadConverter,
} from './payload-converter';

/**
 * Used by the framework to serialize/deserialize method parameters that need to be sent over the
 * wire.
 *
 * @author fateev
 */
export interface DataConverter {
  toPayload<T>(value: T): Payload;

  fromPayload<T>(payload: Payload): T;
  /**
   * Implements conversion of a list of values.
   *
   * @param values JS values to convert to Payloads.
   * @return converted value
   * @throws DataConverterError if conversion of the value passed as parameter failed for any
   *     reason.
   */
  toPayloads(...values: any[]): Payloads | undefined;

  /**
   * Implements conversion of an array of values of different types. Useful for deserializing
   * arguments of function invocations.
   *
   * @param index index of the value in the payloads
   * @param content serialized value to convert to JS values.
   * @return converted JS value
   * @throws DataConverterError if conversion of the data passed as parameter failed for any
   *     reason.
   */
  fromPayloads<T>(index: number, content?: Payloads): T;
}

export class CompositeDataConverter implements DataConverter {
  readonly converters: PayloadConverter[];
  readonly converterByEncoding: Map<string, PayloadConverter> = new Map();

  constructor(...converters: PayloadConverter[]) {
    this.converters = converters;
    for (const converter of converters) {
      this.converterByEncoding.set(converter.encodingType, converter);
    }
  }

  public toPayload<T>(value: T): Payload {
    for (const converter of this.converters) {
      const result = converter.toData(value);
      if (result !== undefined) return result;
    }
    throw new ValueError(`Cannot serialize ${value}`);
  }

  public fromPayload<T>(payload: Payload): T {
    if (payload.metadata === undefined || payload.metadata === null) {
      throw new ValueError('Missing payload metadata');
    }
    const encoding = str(payload.metadata[METADATA_ENCODING_KEY]);
    const converter = this.converterByEncoding.get(encoding);
    if (converter === undefined) {
      throw new ValueError(`Unknown encoding: ${encoding}`);
    }
    return converter.fromData(payload);
  }

  public toPayloads(...values: any[]): Payloads | undefined {
    if (values.length === 0) {
      return undefined;
    }
    // TODO: From Java: Payload.getDefaultInstance()
    const payloads: Payload[] = values.map((value) => this.toPayload(value));
    return { payloads };
  }

  public fromPayloads<T>(index: number, content?: Payloads): T {
    // To make adding arguments a backwards compatible change
    if (content === undefined || !content.payloads || index >= content.payloads.length) {
      // TODO: undefined might not be the right return value here
      return undefined as any;
    }
    return this.fromPayload(content.payloads[index]);
  }
}

export function arrayFromPayloads(converter: DataConverter, content?: Payloads | null): any[] {
  if (!content || !content.payloads) {
    return [];
  }
  return content.payloads.map((payload: Payload) => converter.fromPayload(payload));
}

export function fromPairs<K extends keyof any, V>(source: Array<[K, V]>): Record<K, V> {
  const target = {} as Record<K, V>;
  const len = source.length;
  for (let i = 0; i < len; ++i) {
    const [k, v] = source[i];
    target[k] = v;
  }
  return target;
}

export function mapToPayloads<K extends string>(converter: DataConverter, source: Record<K, any>): Record<K, Payload> {
  return fromPairs(Object.entries(source).map(([k, v]): [K, Payload] => [k as K, converter.toPayload(v)]));
}

export const defaultDataConverter = new CompositeDataConverter(
  new UndefinedPayloadConverter(),
  new BinaryPayloadConverter(),
  new JsonPayloadConverter()
);
