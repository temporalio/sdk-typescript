import { createRegistry } from '@bufbuild/protobuf';
import { DefaultPayloadConverterWithProtobufsEs } from '@temporalio/common/lib/protobufs-es';

// Intentionally registers nothing. Used by tests that need a Worker that
// understands the protobuf-es encoding but does NOT know any specific message
// schema, to exercise the "registry doesn't know this type" error path.
export const payloadConverter = new DefaultPayloadConverterWithProtobufsEs({ registry: createRegistry() });
