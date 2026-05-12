import { create } from '@bufbuild/protobuf';
import { condition, defineQuery, defineSignal, defineUpdate, setHandler } from '@temporalio/workflow';
import {
  ProtoActivityResultSchema,
  type ProtoActivityInput,
  type ProtoActivityResult,
} from '../protos-es-gen/messages_pb';

export const setInputSignal = defineSignal<[ProtoActivityInput]>('setInput');
export const getInputQuery = defineQuery<ProtoActivityInput | undefined>('getInput');
export const sentenceUpdate = defineUpdate<ProtoActivityResult, [ProtoActivityInput]>('sentence');
export const finishSignal = defineSignal('finish');

export async function protobufEsSignalsQueriesUpdates(): Promise<ProtoActivityInput> {
  let lastInput: ProtoActivityInput | undefined;
  let done = false;

  setHandler(setInputSignal, (input) => {
    lastInput = input;
  });
  setHandler(getInputQuery, () => lastInput);
  setHandler(sentenceUpdate, (input) =>
    create(ProtoActivityResultSchema, { sentence: `${input.name} is ${input.age}` })
  );
  setHandler(finishSignal, () => {
    done = true;
  });

  await condition(() => done);
  if (!lastInput) throw new Error('finishSignal received before setInputSignal');
  return lastInput;
}
