/**
 * Type information used to convert an application value to a transfer type appropriate for serialization.
 *
 * Transfer type conversion is applied by SDK conversion helpers when `TypeInfo` is supplied. Calling a
 * `PayloadConverter` directly does not apply it.
 *
 * @experimental
 */
export interface TypeInfo<T = unknown> {
  transferTypeConverter?: TransferTypeConverter<T>;
}

/** @experimental */
export interface TransferTypeConverter<T> {
  fromTransferType(value: unknown): T;
  toTransferType(value: T): unknown;
}
