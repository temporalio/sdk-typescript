import { DefaultPayloadConverterWithProtobufs } from '@temporalio/common/lib/protobufs';
import root, { foo } from '../../protos/root'; // eslint-disable-line import/default

// Used in tests
export const messageInstance = foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });

export const payloadConverter = new DefaultPayloadConverterWithProtobufs({ protobufRoot: root });
