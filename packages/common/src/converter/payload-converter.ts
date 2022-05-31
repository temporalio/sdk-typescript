import { Payload } from './types';

/**
 * Used by the framework to serialize/deserialize data like parameters and return values.
 *
 * This is called inside the [Workflow isolate](https://docs.temporal.io/typescript/determinism).
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
  if (map === undefined || map === null) return undefined;
  return Object.fromEntries(
    Object.entries(map).map(([k, payload]): [K, unknown] => {
      const value = converter.fromPayload(payload as Payload);
      return [k as K, value];
    })
  ) as Record<K, unknown>;
}
