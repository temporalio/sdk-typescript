/**
 * Type information used to convert an application value to a transfer type appropriate for serialization and
 * optionally provide converter-specific metadata.
 *
 * The SDK's TypeInfo-aware converter applies transfer conversion and passes `hint` to the configured
 * `PayloadConverter`. Calling a `PayloadConverter` directly does not apply TypeInfo automatically.
 *
 * @experimental
 */
export interface TypeInfo<T = unknown, D = T> {
  transferTypeConverter?: TransferTypeConverter<T>;
  hint?: ConverterHint<D>;
}

/** @experimental */
export interface TransferTypeConverter<T> {
  fromTransferType(value: unknown): T;
  toTransferType(value: T): unknown;
}

export declare const valueTypeBrand: unique symbol;

/** @experimental */
export interface ConverterHint<T = unknown> {
  converter: string;
  [valueTypeBrand]?: T;
}
