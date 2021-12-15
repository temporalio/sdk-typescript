import { DefaultDataConverter } from '@temporalio/common';
import protobufClasses from '../../protos/protobufs';

export const messageInstance = protobufClasses.ProtoActivityInput.create({ name: 'Proto', age: 1 });

export const dataConverter = new DefaultDataConverter({ protobufClasses });
