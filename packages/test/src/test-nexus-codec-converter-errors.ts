import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import { NexusOperationFailure, Payload } from '@temporalio/common';
import { Client, WorkflowFailedError } from '@temporalio/client';
import type { PayloadCodec } from '@temporalio/common/lib/converter/payload-codec';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

const testService = nexus.service('codec-converter-test', {
  echoOp: nexus.operation<string, string>(),
});

export async function nexusEchoCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusClient({
    endpoint,
    service: testService,
  });
  const handle = await client.startOperation('echoOp', 'hello');
  return await handle.result();
}

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Nexus operation codec failure is retried', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  let decodeCount = 0;
  const failingCodec: PayloadCodec = {
    async encode(payloads: Payload[]): Promise<Payload[]> {
      return payloads;
    },
    async decode(payloads: Payload[]): Promise<Payload[]> {
      decodeCount++;
      if (decodeCount === 1) {
        throw new Error('Intentional codec decode failure');
      }
      return payloads;
    },
  };

  const worker = await createWorker({
    dataConverter: { payloadCodecs: [failingCodec] },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          return input;
        },
      }),
    ],
  });

  const customClient = new Client({
    connection: t.context.env.connection,
    dataConverter: { payloadCodecs: [failingCodec] },
  });

  await worker.runUntil(async () => {
    const result = await customClient.workflow.execute(nexusEchoCaller, {
      taskQueue,
      workflowId: randomUUID(),
      args: [endpointName],
    });
    t.is(result, 'hello');
  });

  t.true(decodeCount >= 2, `Expected decode count >= 2, got ${decodeCount}`);
});

////////////////////////////////////////////////////////////////////////////////////////////////////

test('Nexus operation converter failure is not retried', async (t) => {
  const { createWorker, registerNexusEndpoint, taskQueue } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    dataConverter: { payloadConverterPath: require.resolve('./failing-payload-converter') },
    nexusServices: [
      nexus.serviceHandler(testService, {
        async echoOp(_ctx, input) {
          return input;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const err = await t.throwsAsync(
      () =>
        t.context.env.client.workflow.execute(nexusEchoCaller, {
          taskQueue,
          workflowId: randomUUID(),
          args: [endpointName],
        }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    t.true(err instanceof WorkflowFailedError);
    t.true(err!.cause instanceof NexusOperationFailure);
    const nexusFailure = err!.cause as NexusOperationFailure;
    t.true(nexusFailure.cause instanceof nexus.HandlerError);
    const handlerError = nexusFailure.cause as nexus.HandlerError;
    t.is(handlerError.type, 'BAD_REQUEST');
    t.false(handlerError.retryable);
    t.regex(handlerError.message, /Payload converter failed to decode Nexus operation input/);
  });
});
