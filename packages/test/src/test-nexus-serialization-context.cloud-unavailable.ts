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

const MARKER_KEY = 'nexus-context-marker';
const NO_CONTEXT = 'no-context';

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

function errorChainMessages(err: unknown): string[] {
  const messages: string[] = [];
  for (let cur: unknown = err; cur instanceof Error; cur = cur.cause) {
    messages.push(cur.message);
  }
  return messages;
}

/**
 * Stamps a per-context marker into payload metadata on encode, and requires the same marker on
 * decode. A payload decoded under a different Nexus context, or none, throws rather than silently
 * round-tripping, so a test passes only if each payload is decoded with the exact context it was
 * encoded with. Markers are keyed by context, or by {@link NO_CONTEXT} for payloads serialized
 * without one.
 */
function nexusContextMarkerCodec(markers: Record<string, string>): PayloadCodec {
  const markerFor = (context?: SerializationContext): string | undefined =>
    markers[context == null ? NO_CONTEXT : contextToTraceString(context)];
  return {
    async encode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
      const marker = markerFor(context);
      if (marker == null) return payloads;
      return payloads.map((payload) => ({
        ...payload,
        metadata: { ...payload.metadata, [MARKER_KEY]: new TextEncoder().encode(marker) },
      }));
    },
    async decode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
      return payloads.map((payload) => {
        const stamped = payload.metadata?.[MARKER_KEY];
        if (stamped == null) return payload;
        const found = new TextDecoder().decode(stamped);
        const expected = markerFor(context);
        if (found !== expected) {
          throw new Error(`payload marked '${found}' was decoded as '${expected ?? 'no context'}'`);
        }
        const { [MARKER_KEY]: _marker, ...metadata } = payload.metadata ?? {};
        return { ...payload, metadata };
      });
    },
  };
}

export async function echoOpCaller(endpoint: string, inputTrace: Trace): Promise<Trace> {
  const client = wf.createNexusServiceClient({ endpoint, service: testService });
  const fromOperation = await client.executeOperation('echo', withLabel(inputTrace, 'nexus-input'), {
    summary: 'nexus-summary',
  });
  return withLabel(fromOperation, 'wf-output');
}

export async function twoEndpointCaller(redEndpoint: string, blueEndpoint: string): Promise<[Trace, Trace]> {
  const red = wf.createNexusServiceClient({ endpoint: redEndpoint, service: testService });
  const blue = wf.createNexusServiceClient({ endpoint: blueEndpoint, service: testService });
  return await Promise.all([
    red.executeOperation('echo', makeContextTrace('red-input')),
    blue.executeOperation('echo', makeContextTrace('blue-input')),
  ]);
}

export async function failedOpCaller(endpoint: string): Promise<string[]> {
  const client = wf.createNexusServiceClient({ endpoint, service: testService });
  try {
    await client.executeOperation('fail', 'nexus-boom');
  } catch (err) {
    return errorChainMessages(err);
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
    const serviceClient = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const result = await serviceClient.executeOperation('echo', makeContextTrace('nexus-input'), {
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
    const serviceClient = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const handle = await serviceClient.startOperation('fail', 'nexus-boom', {
      id: `op-${randomUUID()}`,
      scheduleToCloseTimeout: '10s',
    });
    const err = await t.throwsAsync(handle.result());
    const messages = errorChainMessages(err);
    // The failure travels back through the result poll, which must decode it with the operation
    // context rather than context-free.
    t.true(
      messages.some((message) => message.startsWith(`failure.decode.bound|${opCtx}|`)),
      `expected a client-side decode marker in ${JSON.stringify(messages)}`
    );

    // Describe reads the same failure back over a different route: the failure converter is reached
    // through the execution info rather than the result poll, and has to be given the context the
    // description builds from that info.
    const { lastAttemptFailure } = await handle.describe();
    t.truthy(lastAttemptFailure, 'expected the description to report the failed attempt');
    t.true(
      lastAttemptFailure?.message.startsWith(`failure.decode.bound|${opCtx}|`) ?? false,
      `expected a describe-side decode marker in ${JSON.stringify(lastAttemptFailure?.message)}`
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
    const serviceClient = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const started = await serviceClient.startOperation('echo', makeContextTrace('nexus-input'), {
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

test('workflow Nexus user metadata is serialized with the caller context', async (t) => {
  const h = helpers(t);
  const { endpointName } = await h.registerNexusEndpoint();
  const workflowId = `wf-id-${randomUUID()}`;
  // The summary is written by the caller and read back from its history, so it stays on the
  // caller's own context; the operation's payloads around it carry the Nexus one.
  const codec = nexusContextMarkerCodec({
    [workflowCtx(workflowId)]: 'caller',
    [nexusCtx(endpointName, 'testService', 'echo')]: 'operation',
  });
  const client = makeClient(t.context.env, { payloadCodecs: [codec] });
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [codec] },
    nexusServices: [testServiceHandler],
  });

  await worker.runUntil(async () => {
    await client.workflow.execute(echoOpCaller, {
      args: [endpointName, makeContextTrace('wf-input')],
      workflowId,
      taskQueue: h.taskQueue,
    });

    // Read the raw event rather than decoding it: the marker is what identifies the context the
    // summary was encoded under, and decoding would strip it.
    const { history } = await t.context.env.client.workflowService.getWorkflowExecutionHistory({
      namespace: t.context.env.client.options.namespace,
      execution: { workflowId },
    });
    const scheduled = history?.events?.find((e) => e.nexusOperationScheduledEventAttributes != null);
    const marker = scheduled?.userMetadata?.summary?.metadata?.[MARKER_KEY];
    t.is(marker != null ? new TextDecoder().decode(marker) : undefined, 'caller');
  });
});

test('standalone Nexus user metadata is serialized without the operation context', async (t) => {
  const h = helpers(t);
  const { endpointName } = await h.registerNexusEndpoint();
  // NO_CONTEXT marks the summary when it takes its correct, contextless path; 'operation' marks
  // it if a regression routes it through the Nexus context.
  const codec = nexusContextMarkerCodec({
    [nexusCtx(endpointName, 'testService', 'echo')]: 'operation',
    [NO_CONTEXT]: 'metadata',
  });
  const client = makeClient(t.context.env, { payloadCodecs: [codec] });
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [codec] },
    nexusServices: [testServiceHandler],
  });

  await worker.runUntil(async () => {
    const serviceClient = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const handle = await serviceClient.startOperation('echo', makeContextTrace('nexus-input'), {
      id: `op-${randomUUID()}`,
      scheduleToCloseTimeout: '10s',
      summary: 'nexus-summary',
    });
    await handle.result();
    // The summary never reaches the handler, so it carries no operation context; describe reads it
    // back the same way, while the operation's own payloads keep the Nexus context around it.
    const description = await handle.describe();
    t.is(await description.staticSummary(), 'nexus-summary');
  });
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Two endpoints at once

async function registerRedAndBlue(h: ReturnType<typeof helpers>) {
  const [{ endpointName: red }, { endpointName: blue }] = [
    await h.registerNexusEndpoint('red'),
    await h.registerNexusEndpoint('blue'),
  ];
  const redCtx = nexusCtx(red, 'testService', 'echo');
  const blueCtx = nexusCtx(blue, 'testService', 'echo');
  return { red, blue, redCtx, blueCtx, codec: nexusContextMarkerCodec({ [redCtx]: 'red', [blueCtx]: 'blue' }) };
}

test('workflow Nexus operations keep separate contexts per endpoint', async (t) => {
  const h = helpers(t);
  const { red, blue, redCtx, blueCtx, codec } = await registerRedAndBlue(h);
  const client = makeClient(t.context.env, { payloadCodecs: [codec] });
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [codec] },
    nexusServices: [testServiceHandler],
  });
  const workflowId = `wf-id-${randomUUID()}`;

  await worker.runUntil(async () => {
    const [redTrace, blueTrace] = await client.workflow.execute(twoEndpointCaller, {
      args: [red, blue],
      workflowId,
      taskQueue: h.taskQueue,
    });
    t.deepEqual(redTrace.trace, [...encdec('red-input', redCtx), ...encdec('nexus-output', redCtx)]);
    t.deepEqual(blueTrace.trace, [...encdec('blue-input', blueCtx), ...encdec('nexus-output', blueCtx)]);
  });
});

test('standalone Nexus operations keep separate contexts per endpoint', async (t) => {
  const h = helpers(t);
  const { red, blue, redCtx, blueCtx, codec } = await registerRedAndBlue(h);
  const client = makeClient(t.context.env, { payloadCodecs: [codec] });
  const worker = await h.createWorker({
    dataConverter: { ...dataConverter, payloadCodecs: [codec] },
    nexusServices: [testServiceHandler],
  });

  await worker.runUntil(async () => {
    const redClient = client.nexus.createServiceClient({ endpoint: red, service: testService });
    const blueClient = client.nexus.createServiceClient({ endpoint: blue, service: testService });
    const [redResult, blueResult] = await Promise.all([
      redClient.executeOperation('echo', makeContextTrace('red-input'), {
        id: `op-${randomUUID()}`,
        scheduleToCloseTimeout: '10s',
      }),
      blueClient.executeOperation('echo', makeContextTrace('blue-input'), {
        id: `op-${randomUUID()}`,
        scheduleToCloseTimeout: '10s',
      }),
    ]);
    t.deepEqual(redResult.trace, [...encdec('red-input', redCtx), ...encdec('nexus-output', redCtx)]);
    t.deepEqual(blueResult.trace, [...encdec('blue-input', blueCtx), ...encdec('nexus-output', blueCtx)]);
  });
});
