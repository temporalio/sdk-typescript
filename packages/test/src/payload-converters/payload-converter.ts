import { DefaultPayloadConverter } from '@temporalio/common';
import root, { foo } from '../../protos/root';

export const messageInstance = foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });

export const payloadConverter = new DefaultPayloadConverter({ protobufRoot: root });
