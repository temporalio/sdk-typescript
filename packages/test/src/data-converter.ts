import { DefaultDataConverter } from '@temporalio/common';
import protobufClasses from '../protos/protobufs';

export const messageInstance = protobufClasses.FooSignalArgs.create({ name: 'swyx', age: 1 });

export const dataConverter = new DefaultDataConverter({ protobufClasses });
