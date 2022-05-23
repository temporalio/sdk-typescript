/**
 * Entry point for classes and utilities related to using
 * [Protobufs](https://docs.temporal.io/typescript/data-converters#protobufs) for serialization.
 *
 * Import from `@temporalio/common/lib/protobufs`, for example:
 *
 * ```
 * import { patchProtobufRoot } from '@temporalio/common/lib/protobufs';
 * ```
 * @module
 */

// Don't export from index, so we save space in Workflow bundles of users who don't use Protobufs
export * from './converter/protobuf-payload-converters';
export * from './converter/patch-protobuf-root';
