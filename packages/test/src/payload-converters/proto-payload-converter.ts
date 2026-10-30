import { DefaultPayloadConverterWithProtobufs } from '@temporalio/common/protobufs';
import root, { foo } from '../../protos/root'; // oxlint-disable-line import/default

// Used in tests
export const messageInstance = foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });

export const payloadConverter = new DefaultPayloadConverterWithProtobufs({ protobufRoot: root });
