import type { ProtoActivityInput } from '../protos-es-gen/messages_pb';

export async function echoProtoEsInput(input: ProtoActivityInput): Promise<ProtoActivityInput> {
  return input;
}
