import { PayloadCodec } from './payload-codec';
import { PayloadConverter } from './payload-converter';

/**
 * When your data (arguments and return values) is sent over the wire and stored by Temporal Server,
 * it is encoded in binary in a {@link Payload} Protobuf message.
 *
 * The default `DataConverter` supports `Uint8Array`, protobuf.js objects, and JSON serializables (so if [`JSON.stringify(yourArgOrRetval)`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#description) works, the default data converter will work).
 *
 * Use a custom `DataConverter` to control the contents of your {@link Payload}s.
 * Common reasons for using a custom `DataConverter` are:
 * - Converting values that are not supported by the default `DataConverter` (for example, `JSON.stringify()` doesn't handle `BigInt`s, so if you want to return `{ total: 1000n }` from a Workflow, Signal, or Activity, you need your own `DataConverter`).
 * - Encrypting values that may contain private information that you don't want stored in plaintext in Temporal Server's database.
 * - Compressing values to reduce disk or network usage.
 *
 * To use your custom `DataConverter`, provide it to the {@link WorkflowClient}, {@link Worker}, and {@link bundleWorkflowCode} (if you use it):
 * - `new WorkflowClient({ ..., dataConverter })`
 * - `Worker.create({ ..., dataConverter })`
 * - `bundleWorkflowCode({ ..., payloadConverterPath })`
 */
export interface DataConverter {
  /**
   * Path of a file that has a `payloadConverter` named export.
   * `payloadConverter` should be an instance of a class that implements {@link PayloadConverter}.
   * If no path is provided, {@link defaultPayloadConverter} is used.
   */
  payloadConverterPath?: string;

  /**
   * A {@link PayloadCodec} instance. The default codec is a no-op.
   */
  payloadCodec?: PayloadCodec;
}

/**
 * A {@link DataConverter} that has been loaded via {@link loadDataConverter}.
 */
export interface LoadedDataConverter {
  payloadConverter: PayloadConverter;
  payloadCodec: PayloadCodec;
}
