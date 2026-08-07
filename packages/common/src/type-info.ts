/**
 * Describes how SDK conversion helpers adapt an application value of type `T` for payload conversion.
 *
 * {@link transferTypeConverter} performs an application-defined, payload-converter-independent transformation.
 * For example, it can convert a class instance into a plain object before JSON serialization.
 *
 * {@link payloadConverterHint} carries metadata for a specific payload converter and describes its value type `D`.
 * For example, a Protobuf converter hint can identify the message type required to deserialize bytes.
 *
 * On encoding, transfer type conversion runs before payload conversion. On decoding, payload conversion runs before
 * transfer type conversion. Either mechanism may be used independently or they may be combined.
 *
 * When {@link transferTypeConverter} is unspecified, `D` should be the same type as `T`.
 *
 * SDK conversion helpers apply this information when supplied. Calling a {@link PayloadConverter} directly does not.
 *
 * @experimental
 */
export interface TypeInfo<T = unknown, D = T> {
  /**
   * Converts between the application value and a representation suitable for payload conversion.
   *
   * This transformation runs outside the payload converter and should not depend on its serialization format.
   */
  transferTypeConverter?: TransferTypeConverter<T, D>;

  /**
   * Metadata forwarded unchanged to the payload converter.
   *
   * Use this when conversion requires format-specific runtime information, such as a Protobuf message type.
   */
  payloadConverterHint?: ConverterHint<D>;
}

/**
 * Converts between an application value of type `T` and its payload-converter-independent representation of type `D`.
 *
 * @experimental
 */
export interface TransferTypeConverter<T, D = unknown> {
  fromTransferType(value: D): T;
  toTransferType(value: T): D;
}

declare const valueTypeBrand: unique symbol;

/**
 * Identifies converter-specific metadata and associates it with the value type `T` handled by that converter.
 *
 * The association applies to an individual payload conversion; it does not bind a payload converter instance to `T`.
 *
 * Extend this interface to define metadata for a payload converter.
 *
 * @experimental
 */
export interface ConverterHint<T = unknown> {
  converter: string;
  [valueTypeBrand]?: T;
}

/** @experimental */
export interface PayloadTypeInfo {
  inputTypes?: readonly TypeInfo[];
  outputType?: TypeInfo;
}
