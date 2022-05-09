import { defaultPayloadConverter } from '@temporalio/common';
import { WrappedPayloadConverter } from '@temporalio/common/lib/converter/wrapped-payload-converter';
import { DefaultPayloadConverterWithProtobufs } from '@temporalio/common/lib/protobufs';
import root, { foo } from '../../protos/root';

// Used in tests
export const messageInstance = foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });

export const payloadConverter = new WrappedPayloadConverter(
  new DefaultPayloadConverterWithProtobufs({ protobufRoot: root })
);

export const wrappedDefaultPayloadConverter = new WrappedPayloadConverter(defaultPayloadConverter);
