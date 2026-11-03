import test from 'ava';
import type { PayloadCodec } from '@temporalio/common';
import { defaultPayloadConverter } from '@temporalio/common';
import { WorkflowCodecRunner } from '@temporalio/worker/internal';

// In-place modification catches accidental sharing of caller-owned payload bytes.
const codec: PayloadCodec = {
  async encode(payloads) {
    for (const payload of payloads)
      payload.data?.forEach((byte, index, data) => {
        data[index] = byte + 1;
      });
    return payloads;
  },
  async decode(payloads) {
    for (const payload of payloads)
      payload.data?.forEach((byte, index, data) => {
        data[index] = byte - 1;
      });
    return payloads;
  },
};
const context = { type: 'workflow' as const, namespace: 'default', workflowId: 'wf' };
const headers = { custom: defaultPayloadConverter.toPayload('header') };

for (const enabled of [false, true]) {
  test(`header codecs round trip at workflow boundaries (enabled=${enabled})`, async (t) => {
    const encoded = enabled
      ? (await codec.encode(structuredClone([headers.custom])))[0]!
      : structuredClone(headers.custom);
    const runner = new WorkflowCodecRunner([codec], context, enabled);
    const decoded = await runner.decodeActivation({
      runId: 'run',
      jobs: [{ signalWorkflow: { signalName: 'signal', headers: { custom: structuredClone(encoded) } } }],
    });
    t.deepEqual(decoded.jobs?.[0]?.signalWorkflow?.headers?.custom?.data, headers.custom.data);
    const completion = await runner.encodeCompletion({
      successful: { commands: [{ continueAsNewWorkflowExecution: { headers: structuredClone(headers) } }] },
    });
    t.deepEqual(
      completion.successful?.commands?.[0]?.continueAsNewWorkflowExecution?.headers?.custom?.data,
      encoded.data
    );
  });
}
