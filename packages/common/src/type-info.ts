/**
 * Type information used to convert an application value to a transfer type appropriate for serialization and
 * optionally provide converter-specific metadata.
 *
 * Transfer type conversion and converter hints are applied by SDK conversion helpers when `TypeInfo` is supplied.
 * Calling a `PayloadConverter` directly does not apply it.
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
