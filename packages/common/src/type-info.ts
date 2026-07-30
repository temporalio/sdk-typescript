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
  transferTypeConverter?: TransferTypeConverter<T>;

  /**
   * Metadata forwarded unchanged to the payload converter.
   *
   * Use this when conversion requires format-specific runtime information, such as a Protobuf message type.
   */
  payloadConverterHint?: ConverterHint<D>;
}

/**
 * Converts between an application value and its payload-converter-independent transfer representation.
 *
 * @experimental
 */
export interface TransferTypeConverter<T> {
  fromTransferType(value: unknown): T;
  toTransferType(value: T): unknown;
}

declare const valueTypeBrand: unique symbol;

/**
 * Identifies converter-specific metadata and associates it with the value type `T` handled by that converter.
 *
 * Extend this interface to define metadata for a payload converter.
 *
 * @experimental
 */
export interface ConverterHint<T = unknown> {
  converter: string;
  [valueTypeBrand]?: T;
}
