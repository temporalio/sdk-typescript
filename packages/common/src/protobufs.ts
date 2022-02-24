// Don't export from index to save space in Workflow bundle for users who don't use Protobufs
// Import with:
// import { patchProtobufRoot } from '@temporalio/common/lib/protobufs';
export * from './converter/protobuf-payload-converters';
export * from './converter/patch-protobuf-root';
