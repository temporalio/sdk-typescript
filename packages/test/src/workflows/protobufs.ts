import type { FooSignalArgs } from '../../protos/protobufs';

export async function protobufWorkflow(args: FooSignalArgs): Promise<FooSignalArgs> {
  console.log(typeof args, args);
  return args;
}
