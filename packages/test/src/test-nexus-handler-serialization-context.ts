import { randomUUID } from 'crypto';
import test from 'ava';
import * as nexus from 'nexus-rpc';
import type { Client } from '@temporalio/client';
import type { ProtoFailure } from '@temporalio/common';
import { noopMetricMeter } from '@temporalio/common';
import { loadDataConverter } from '@temporalio/common/internal/internal-non-workflow';
import type { temporal } from '@temporalio/proto';
import { DefaultLogger } from '@temporalio/worker';
import { NexusHandler } from '@temporalio/worker/internal';
import { nexusCtx } from './payload-converters/serialization-context-converter';

const converterPath = require.resolve('./payload-converters/serialization-context-converter');

const ENDPOINT = 'my-endpoint';
const SERVICE = 'my-service';
const OPERATION = 'my-operation';

/** A service whose cancel always fails, to exercise the cancel task's own failure path. */
const cancelThrowsService = nexus.service(SERVICE, {
  [OPERATION]: nexus.operation<void, void>(),
});

const cancelThrowsHandler = new Map<string, nexus.ServiceHandler<any>>();
cancelThrowsHandler.set(
  SERVICE,
  nexus.serviceHandler(cancelThrowsService, {
    [OPERATION]: {
      async start() {
        throw new nexus.HandlerError('INTERNAL', 'unused by these tests');
      },
      async cancel() {
        throw new nexus.HandlerError('INTERNAL', 'deliberate cancel failure', { retryableOverride: false });
      },
    },
  })
);

function makeHandler(services: Map<string, nexus.ServiceHandler<any>>): NexusHandler {
  const abortController = new AbortController();
  return new NexusHandler(
    new Uint8Array([1, 2, 3]),
    'default',
    'my-task-queue',
    {
      service: SERVICE,
      operation: OPERATION,
      headers: {},
      abortSignal: abortController.signal,
      requestDeadline: undefined,
    } as nexus.OperationContext,
    // `run` only uses the client to tie outbound calls to the abort signal.
    { withAbortSignal: (_signal: AbortSignal, fn: () => unknown) => fn() } as unknown as Client,
    abortController,
    services,
    loadDataConverter({ payloadConverterPath: converterPath, failureConverterPath: converterPath }),
    new DefaultLogger('ERROR'),
    noopMetricMeter,
    []
  );
}

async function runTask(
  request: temporal.api.nexus.v1.IRequest,
  services: Map<string, nexus.ServiceHandler<any>> = new Map()
): Promise<ProtoFailure | undefined> {
  const completion = await makeHandler(services).run({ taskToken: new Uint8Array([1, 2, 3]), request });
  return (completion.failure ?? undefined) as ProtoFailure | undefined;
}

test('a malformed start request fails with the operation context', async (t) => {
  // No requestId: rejected by the worker before the handler is ever consulted.
  const failure = await runTask({
    endpoint: ENDPOINT,
    startOperation: { service: SERVICE, operation: OPERATION },
  });
  t.true(
    failure?.message?.startsWith(`failure.encode.bound|${nexusCtx(ENDPOINT, SERVICE, OPERATION)}|`),
    `expected the operation context in ${JSON.stringify(failure?.message)}`
  );
});

test('a cancel request without an operation token fails with the operation context', async (t) => {
  const failure = await runTask({
    endpoint: ENDPOINT,
    cancelOperation: { service: SERVICE, operation: OPERATION },
  });
  t.true(
    failure?.message?.startsWith(`failure.encode.bound|${nexusCtx(ENDPOINT, SERVICE, OPERATION)}|`),
    `expected the operation context in ${JSON.stringify(failure?.message)}`
  );
});

test('an unregistered service fails with the operation context', async (t) => {
  const failure = await runTask({
    endpoint: ENDPOINT,
    startOperation: { service: SERVICE, operation: OPERATION, requestId: randomUUID() },
  });
  t.true(
    failure?.message?.startsWith(`failure.encode.bound|${nexusCtx(ENDPOINT, SERVICE, OPERATION)}|`),
    `expected the operation context in ${JSON.stringify(failure?.message)}`
  );
});

test('a task without an endpoint is scoped by an empty endpoint', async (t) => {
  const failure = await runTask({
    startOperation: { service: SERVICE, operation: OPERATION, requestId: randomUUID() },
  });
  t.true(
    failure?.message?.startsWith(`failure.encode.bound|${nexusCtx('', SERVICE, OPERATION)}|`),
    `expected an empty endpoint in ${JSON.stringify(failure?.message)}`
  );
});

test('a failing cancel carries the operation context', async (t) => {
  const failure = await runTask(
    {
      endpoint: ENDPOINT,
      cancelOperation: { service: SERVICE, operation: OPERATION, operationToken: 'some-token' },
    },
    cancelThrowsHandler
  );
  t.true(
    failure?.message?.startsWith(`failure.encode.bound|${nexusCtx(ENDPOINT, SERVICE, OPERATION)}|`),
    `expected the operation context in ${JSON.stringify(failure?.message)}`
  );
});
