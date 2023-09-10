import { DefaultFailureConverter, FailureConverter } from './failure-converter';
import { PayloadCodec } from './payload-codec';
import { defaultPayloadConverter, PayloadConverter } from './payload-converter';

/**
 * When your data (arguments and return values) is sent over the wire and stored by Temporal Server, it is encoded in
 * binary in a {@link Payload} Protobuf message.
 *
 * The default `DataConverter` supports `undefined`, `Uint8Array`, and JSON serializables (so if
 * {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#description | `JSON.stringify(yourArgOrRetval)`}
 * works, the default data converter will work). Protobufs are supported via
 * {@link https://docs.temporal.io/typescript/data-converters#protobufs | this API}.
 *
 * Use a custom `DataConverter` to control the contents of your {@link Payload}s. Common reasons for using a custom
 * `DataConverter` are:
 * - Converting values that are not supported by the default `DataConverter` (for example, `JSON.stringify()` doesn't
 *   handle `BigInt`s, so if you want to return `{ total: 1000n }` from a Workflow, Signal, or Activity, you need your
 *   own `DataConverter`).
 * - Encrypting values that may contain private information that you don't want stored in plaintext in Temporal Server's
 *   database.
 * - Compressing values to reduce disk or network usage.
 *
 * To use your custom `DataConverter`, provide it to the {@link WorkflowClient}, {@link Worker}, and
 * {@link bundleWorkflowCode} (if you use it):
 * - `new WorkflowClient({ ..., dataConverter })`
 * - `Worker.create({ ..., dataConverter })`
 * - `bundleWorkflowCode({ ..., payloadConverterPath })`
 */
export interface DataConverter {
  /**
   * Path of a file that has a `payloadConverter` named export.
   * `payloadConverter` should be an object that implements {@link PayloadConverter}.
   * If no path is provided, {@link defaultPayloadConverter} is used.
   */
  payloadConverterPath?: string;

  /**
   * Path of a file that has a `failureConverter` named export.
   * `failureConverter` should be an object that implements {@link FailureConverter}.
   * If no path is provided, {@link defaultFailureConverter} is used.
   */
  failureConverterPath?: string;

  /**
   * An array of {@link PayloadCodec} instances.
   *
   * Payloads are encoded in the order of the array and decoded in the opposite order. For example, if you have a
   * compression codec and an encryption codec, then you want data to be encoded with the compression codec first, so
   * you'd do `payloadCodecs: [compressionCodec, encryptionCodec]`.
   */
  payloadCodecs?: PayloadCodec[];
}

/**
 * A {@link DataConverter} that has been loaded via {@link loadDataConverter}.
 */
export interface LoadedDataConverter {
  payloadConverter: PayloadConverter;
  failureConverter: FailureConverter;
  payloadCodecs: PayloadCodec[];
}

/**
 * The default {@link FailureConverter} used by the SDK.
 *
 * Error messages and stack traces are serizalized as plain text.
 */
export const defaultFailureConverter: FailureConverter = new DefaultFailureConverter();

/**
 * A "loaded" data converter that uses the default set of failure and payload converters.
 */
export const defaultDataConverter: LoadedDataConverter = {
  payloadConverter: defaultPayloadConverter,
  failureConverter: defaultFailureConverter,
  payloadCodecs: [],
};
