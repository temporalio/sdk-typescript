/**
 * Serialization context coverage for Nexus Operations.
 *
 * Operation inputs, results, and failures are converted with a
 * {@link NexusSerializationContext} identifying the endpoint, service and operation; this holds on
 * both sides of the call, for Workflow callers and for standalone Client callers. A handle obtained
 * from {@link NexusClient.getHandle} knows none of those three and therefore decodes without
 * context.
 */
import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import { Client } from '@temporalio/client';
import { ApplicationFailure, type Payload, type PayloadCodec, type SerializationContext } from '@temporalio/common';
import { workflowInterceptorModules } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';
import * as wf from '@temporalio/workflow';
import type { TestWorkflowEnvironment } from './helpers';
import { bundlerOptions } from './helpers';
import type { Context } from './helpers-integration';
import { createTestWorkflowEnvironment, helpers, makeConfigurableEnvironmentTestFn } from './helpers-integration';
import type { ContextTrace } from './payload-converters/serialization-context-converter';
import {
  contextToTraceString,
  dec,
  enc,
  encdec,
  makeContextTrace,
  nexusCtx,
  withLabel,
  workflowCtx,
} from './payload-converters/serialization-context-converter';

type Trace = ContextTrace<string>;

const converterPath = require.resolve('./payload-converters/serialization-context-converter');
const dataConverter = { payloadConverterPath: converterPath, failureConverterPath: converterPath };

const test = makeConfigurableEnvironmentTestFn<Context>({
  createTestContext: async () => {
    const env = await createTestWorkflowEnvironment({
      server: {
        extraArgs: [
          '--dynamic-config-value',
          'nexusoperation.enableStandalone=true',
          '--dynamic-config-value',
          'system.refreshNexusEndpointsMinWait="0s"',
        ],
      },
    });
    const workflowBundle = await bundleWorkflowCode({
      ...bundlerOptions,
      workflowInterceptorModules: [...workflowInterceptorModules],
      workflowsPath: __filename,
      payloadConverterPath: converterPath,
      failureConverterPath: converterPath,
    });
    return { env, workflowBundle };
  },
  teardown: async (c) => {
    await c.env.teardown();
  },
});

function makeClient(env: TestWorkflowEnvironment, overrides?: { payloadCodecs?: PayloadCodec[] }): Client {
  return new Client({
    connection: env.client.connection,
    namespace: env.client.options.namespace,
    dataConverter: { ...dataConverter, ...overrides },
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Service, handler, and caller Workflows

const testService = nexus.service('testService', {
  echo: nexus.operation<Trace, Trace>(),
  fail: nexus.operation<string, void>(),
});

const testServiceHandler = nexus.serviceHandler(testService, {
  async echo(_ctx, input) {
    return withLabel(input, 'nexus-output');
  },
  async fail(_ctx, message) {
    throw ApplicationFailure.create({ message, nonRetryable: true });
  },
});

export async function echoOpCaller(endpoint: string, inputTrace: Trace): Promise<Trace> {
  const client = wf.createNexusServiceClient({ endpoint, service: testService });
  const fromOperation = await client.executeOperation('echo', withLabel(inputTrace, 'nexus-input'), {
    summary: 'nexus-summary',
  });
  return withLabel(fromOperation, 'wf-output');
}

export async function failedOpCaller(endpoint: string): Promise<string[]> {
  const client = wf.createNexusServiceClient({ endpoint, service: testService });
  try {
    await client.executeOperation('fail', 'nexus-boom');
  } catch (err) {
    const messages: string[] = [];
    for (let cur: unknown = err; cur instanceof Error; cur = cur.cause) {
      messages.push(cur.message);
    }
    return messages;
  }
  throw ApplicationFailure.nonRetryable('expected the Nexus operation to fail');
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Tests

test('workflow Nexus caller and handler payloads carry Nexus context', async (t) => {
  const h = helpers(t);
  const client = makeClient(t.context.env);
  const { endpointName } = await h.registerNexusEndpoint();
  const worker = await h.createWorker({ dataConverter, nexusServices: [testServiceHandler] });
  const workflowId = `wf-id-${randomUUID()}`;
  const wfCtx = workflowCtx(workflowId);
  const opCtx = nexusCtx(endpointName, 'testService', 'echo');

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(echoOpCaller, {
      args: [endpointName, makeContextTrace('wf-input')],
      workflowId,
      taskQueue: h.taskQueue,
    });
    t.deepEqual(await handle.result(), {
      label: 'wf-output',
      trace: [
        ...encdec('wf-input', wfCtx),
        ...encdec('nexus-input', opCtx),
        ...encdec('nexus-output', opCtx),
        ...encdec('wf-output', wfCtx),
      ],
    });
  });
});

test('workflow Nexus failures carry Nexus context', async (t) => {
  const h = helpers(t);
  const client = makeClient(t.context.env);
  const { endpointName } = await h.registerNexusEndpoint();
  const worker = await h.createWorker({ dataConverter, nexusServices: [testServiceHandler] });
  const opCtx = nexusCtx(endpointName, 'testService', 'fail');

  await worker.runUntil(async () => {
    const messages = await client.workflow.execute(failedOpCaller, {
      args: [endpointName],
      workflowId: `wf-id-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    // The caller decodes the failure it observes; the handler encoded the failure it raised.
    t.true(
      messages.some((message) => message.startsWith(`failure.decode.bound|${opCtx}|`)),
      `expected a caller-side decode marker in ${JSON.stringify(messages)}`
    );
    t.true(
      messages.some((message) => message.includes(`failure.encode.bound|${opCtx}|`)),
      `expected a handler-side encode marker in ${JSON.stringify(messages)}`
    );
  });
});

test('standalone Nexus operation payloads carry Nexus context', async (t) => {
  const h = helpers(t);
  const client = makeClient(t.context.env);
  const { endpointName } = await h.registerNexusEndpoint();
  const worker = await h.createWorker({ dataConverter, nexusServices: [testServiceHandler] });
  const opCtx = nexusCtx(endpointName, 'testService', 'echo');

  await worker.runUntil(async () => {
    const service = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const result = await service.executeOperation('echo', makeContextTrace('nexus-input'), {
      id: `op-${randomUUID()}`,
      scheduleToCloseTimeout: '10s',
    });
    t.deepEqual(result, {
      label: 'nexus-output',
      trace: [...encdec('nexus-input', opCtx), ...encdec('nexus-output', opCtx)],
    });
  });
});

test('standalone Nexus failures carry Nexus context', async (t) => {
  const h = helpers(t);
  const client = makeClient(t.context.env);
  const { endpointName } = await h.registerNexusEndpoint();
  const worker = await h.createWorker({ dataConverter, nexusServices: [testServiceHandler] });
  const opCtx = nexusCtx(endpointName, 'testService', 'fail');

  await worker.runUntil(async () => {
    const service = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const err = await t.throwsAsync(
      service.executeOperation('fail', 'nexus-boom', {
        id: `op-${randomUUID()}`,
        scheduleToCloseTimeout: '10s',
      })
    );
    const messages: string[] = [];
    for (let cur: unknown = err; cur instanceof Error; cur = cur.cause) {
      messages.push(cur.message);
    }
    // The failure travels back through the result poll, which must decode it with the operation
    // context rather than context-free.
    t.true(
      messages.some((message) => message.startsWith(`failure.decode.bound|${opCtx}|`)),
      `expected a client-side decode marker in ${JSON.stringify(messages)}`
    );
  });
});

test('standalone Nexus handle obtained by id has no Nexus context', async (t) => {
  const h = helpers(t);
  const client = makeClient(t.context.env);
  const { endpointName } = await h.registerNexusEndpoint();
  const worker = await h.createWorker({ dataConverter, nexusServices: [testServiceHandler] });
  const opCtx = nexusCtx(endpointName, 'testService', 'echo');
  const operationId = `op-${randomUUID()}`;

  await worker.runUntil(async () => {
    const service = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const started = await service.startOperation('echo', makeContextTrace('nexus-input'), {
      id: operationId,
      scheduleToCloseTimeout: '10s',
    });
    await started.result();

    const detached = client.nexus.getHandle<Trace>(operationId);
    t.deepEqual(await detached.result(), {
      label: 'nexus-output',
      trace: [
        enc('nexus-input', opCtx),
        dec('nexus-input', opCtx),
        enc('nexus-output', opCtx),
        'payload.decode.free|nexus-output',
      ],
    });
  });
});

/**
 * Flips bytes only for one exact endpoint/service/operation, on both encode and decode, so a
 * payload comes back mangled whenever the encoding and decoding sides disagree about which Nexus
 * operation it belongs to.
 */
function nexusOnlyCodec(expected: string): PayloadCodec {
  const flip = (payloads: Payload[], context?: SerializationContext): Payload[] => {
    if (context?.type !== 'nexus' || contextToTraceString(context) !== expected) return payloads;
    return payloads.map((payload) => ({ ...payload, data: payload.data?.map((byte) => byte ^ 0xff) }));
  };
  return {
    async encode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
      return flip(payloads, context);
    },
    async decode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
      return flip(payloads, context);
    },
  };
}

test('standalone Nexus describe reads user metadata with Nexus context', async (t) => {
  const h = helpers(t);
  const { endpointName } = await h.registerNexusEndpoint();
  const codec = nexusOnlyCodec(nexusCtx(endpointName, 'testService', 'echo'));
  const client = makeClient(t.context.env, { payloadCodecs: [codec] });
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [codec] },
    nexusServices: [testServiceHandler],
  });

  await worker.runUntil(async () => {
    const service = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const handle = await service.startOperation('echo', makeContextTrace('nexus-input'), {
      id: `op-${randomUUID()}`,
      scheduleToCloseTimeout: '10s',
      summary: 'nexus-summary',
    });
    await handle.result();
    // The summary was encoded under the start request's endpoint/service/operation; describe can
    // only read it back if it rebuilds the same three from the execution info.
    const description = await handle.describe();
    t.is(await description.staticSummary(), 'nexus-summary');
  });
});
