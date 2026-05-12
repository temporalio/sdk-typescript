/**
 * Entry point for the `@bufbuild/protobuf` v2 payload-converter classes.
 *
 * Parallels {@link module:protobufs} but targets generated code emitted by
 * `@bufbuild/protoc-gen-es` instead of `protobufjs`.
 *
 * See {@link https://github.com/temporalio/sdk-typescript/blob/main/docs/protobuf-libraries.md | docs/protobuf-libraries.md}
 * for a comparison of the two flows and a minimal end-to-end example.
 *
 * Import from `@temporalio/common/lib/protobufs-es`, for example:
 *
 * ```
 * import { DefaultPayloadConverterWithProtobufsEs } from '@temporalio/common/lib/protobufs-es';
 * ```
 * @module
 */

// Don't export from index, so we save space in Workflow bundles of users who don't use Protobufs
export * from './converter/protobuf-es-payload-converters';
