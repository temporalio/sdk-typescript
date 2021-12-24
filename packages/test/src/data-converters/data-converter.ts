import { DefaultDataConverter } from '@temporalio/common';
import root, { foo } from '../../protos/root';

export const messageInstance = foo.bar.ProtoActivityInput.create({ name: 'Proto', age: 1 });

export const dataConverter = new DefaultDataConverter({ root });
