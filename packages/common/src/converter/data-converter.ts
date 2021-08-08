import { ValueError } from '../errors';
import { str, METADATA_ENCODING_KEY, Payload } from './types';
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
 * Implement this in order to customize worker data serialization or use the default data converter which supports `Uint8Array` and JSON serializables.
 */
export interface DataConverter {
  toPayload<T>(value: T): Promise<Payload>;

  fromPayload<T>(payload: Payload): Promise<T>;
  /**
   * Implements conversion of a list of values.
   *
   * @param values JS values to convert to Payloads.
   * @return converted value
   * @throws DataConverterError if conversion of the value passed as parameter failed for any
   *     reason.
   */
  toPayloads(...values: unknown[]): Promise<Payload[] | undefined>;

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
  fromPayloads<T>(index: number, content?: Payload[] | null): Promise<T>;

  /**
   * Sync conversion of single payload, used in the Workflow runtime
   */
  toPayloadSync<T>(value: T): Payload;

  /**
   * Sync conversion from a single payload, used in the Workflow runtime
   */
  fromPayloadSync<T>(payload: Payload): T;
  /**
   * Sync conversion of all arguments, used in the Workflow runtime
   *
   * Implements conversion of a list of values.
   *
   * @param values JS values to convert to Payloads.
   * @return converted value
   * @throws DataConverterError if conversion of the value passed as parameter failed for any
   *     reason.
   */
  toPayloadsSync(...values: unknown[]): Payload[] | undefined;

  /**
   * Sync version of {@link fromPayloads}
   */
  fromPayloadsSync<T>(index: number, content?: Payload[] | null): T;
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

  public async toPayload<T>(value: T): Promise<Payload> {
    for (const converter of this.converters) {
      const result = await converter.toData(value);
      if (result !== undefined) return result;
    }
    throw new ValueError(`Cannot serialize ${value}`);
  }

  public toPayloadSync<T>(value: T): Payload {
    for (const converter of this.converters) {
      const result = converter.toDataSync(value);
      if (result !== undefined) return result;
    }
    throw new ValueError(`Cannot serialize ${value}`);
  }

  public async fromPayload<T>(payload: Payload): Promise<T> {
    if (payload.metadata === undefined || payload.metadata === null) {
      throw new ValueError('Missing payload metadata');
    }
    const encoding = str(payload.metadata[METADATA_ENCODING_KEY]);
    const converter = this.converterByEncoding.get(encoding);
    if (converter === undefined) {
      throw new ValueError(`Unknown encoding: ${encoding}`);
    }
    return await converter.fromData(payload);
  }

  public fromPayloadSync<T>(payload: Payload): T {
    if (payload.metadata === undefined || payload.metadata === null) {
      throw new ValueError('Missing payload metadata');
    }
    const encoding = str(payload.metadata[METADATA_ENCODING_KEY]);
    const converter = this.converterByEncoding.get(encoding);
    if (converter === undefined) {
      throw new ValueError(`Unknown encoding: ${encoding}`);
    }
    return converter.fromDataSync(payload);
  }

  public async toPayloads(...values: unknown[]): Promise<Payload[] | undefined> {
    if (values.length === 0) {
      return undefined;
    }
    return await Promise.all(values.map((value) => this.toPayload(value)));
  }

  public toPayloadsSync(...values: unknown[]): Payload[] | undefined {
    if (values.length === 0) {
      return undefined;
    }
    return values.map((value) => this.toPayloadSync(value));
  }

  public async fromPayloads<T>(index: number, payloads?: Payload[] | null): Promise<T> {
    // To make adding arguments a backwards compatible change
    if (payloads === undefined || payloads === null || index >= payloads.length) {
      return undefined as any;
    }
    return await this.fromPayload(payloads[index]);
  }

  public fromPayloadsSync<T>(index: number, payloads?: Payload[] | null): T {
    // To make adding arguments a backwards compatible change
    if (payloads === undefined || payloads === null || index >= payloads.length) {
      return undefined as any;
    }
    return this.fromPayloadSync(payloads[index]);
  }
}

export async function arrayFromPayloads(converter: DataConverter, content?: Payload[] | null): Promise<unknown[]> {
  if (!content) {
    return [];
  }
  return await Promise.all(content.map((payload: Payload) => converter.fromPayload(payload)));
}

export async function mapToPayloads<K extends string>(
  converter: DataConverter,
  source: Record<K, any>
): Promise<Record<K, Payload>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(source).map(async ([k, v]): Promise<[K, Payload]> => [k as K, await converter.toPayload(v)])
    )
  ) as Record<K, Payload>;
}

export function arrayFromPayloadsSync(converter: DataConverter, content?: Payload[] | null): unknown[] {
  if (!content) {
    return [];
  }
  return content.map((payload: Payload) => converter.fromPayloadSync(payload));
}

export function mapToPayloadsSync<K extends string>(
  converter: DataConverter,
  source: Record<K, any>
): Record<K, Payload> {
  return Object.fromEntries(
    Object.entries(source).map(([k, v]): [K, Payload] => [k as K, converter.toPayloadSync(v)])
  ) as Record<K, Payload>;
}

export const defaultDataConverter = new CompositeDataConverter(
  new UndefinedPayloadConverter(),
  new BinaryPayloadConverter(),
  new JsonPayloadConverter()
);
