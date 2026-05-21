import { create, createRegistry } from '@bufbuild/protobuf';
import { DefaultPayloadConverterWithProtobufsEs } from '@temporalio/common/lib/protobufs-es';
import {
  BinaryMessageSchema,
  MapMessageSchema,
  OneofMessageSchema,
  ProtoActivityInputSchema,
  ProtoActivityResultSchema,
  WrapperSchema,
} from '../protos-es-gen/messages_pb';
import { ProtoActivityInputSchema as NamespacedProtoActivityInputSchema } from '../protos-es-gen/namespaced-messages_pb';

const registry = createRegistry(
  ProtoActivityInputSchema,
  ProtoActivityResultSchema,
  BinaryMessageSchema,
  WrapperSchema,
  OneofMessageSchema,
  MapMessageSchema,
  NamespacedProtoActivityInputSchema
);

// Used in tests
export const messageInstance = create(NamespacedProtoActivityInputSchema, { name: 'Proto', age: 1 });

export const payloadConverter = new DefaultPayloadConverterWithProtobufsEs({ registry });
