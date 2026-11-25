import { randomUUID } from 'crypto';
import test from 'ava';
import * as nexus from 'nexus-rpc';
import type { Client } from '@temporalio/client';
import type { DataConverter, ProtoFailure } from '@temporalio/common';
import { defaultPayloadConverter, noopMetricMeter } from '@temporalio/common';
import { loadDataConverter } from '@temporalio/common/internal/internal-non-workflow';
import { operationInfo, TemporalOperationHandler, TemporalOperationResult } from '@temporalio/nexus';
import { generateWorkflowRunOperationToken } from '@temporalio/nexus/internal';
import type { temporal } from '@temporalio/proto';
import type { NexusInterceptorsFactory } from '@temporalio/worker';
import { DefaultLogger } from '@temporalio/worker';
import { NexusHandler } from '@temporalio/worker/internal';
import { enc, makeContextTrace, nexusCtx } from './payload-converters/serialization-context-converter';

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

function makeHandler(
  services: Map<string, nexus.ServiceHandler<any>>,
  {
    abortController = new AbortController(),
    headers = {},
    interceptors = [],
    onClientAbortSignal,
    dataConverter = { payloadConverterPath: converterPath, failureConverterPath: converterPath },
  }: {
    abortController?: AbortController;
    headers?: Record<string, string>;
    interceptors?: NexusInterceptorsFactory[];
    onClientAbortSignal?: (signal: AbortSignal) => void;
    dataConverter?: DataConverter;
  } = {}
): NexusHandler {
  return new NexusHandler(
    new Uint8Array([1, 2, 3]),
    'default',
    'my-task-queue',
    {
      service: SERVICE,
      operation: OPERATION,
      headers,
      abortSignal: abortController.signal,
      requestDeadline: undefined,
    } as nexus.OperationContext,
    // `run` only uses the client to tie outbound calls to the abort signal.
    {
      withAbortSignal: (signal: AbortSignal, fn: () => unknown) => {
        onClientAbortSignal?.(signal);
        return fn();
      },
    } as unknown as Client,
    abortController,
    services,
    loadDataConverter(dataConverter),
    new DefaultLogger('ERROR'),
    noopMetricMeter,
    interceptors
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

test('a synchronous Nexus handler can return operation info with the default converter', async (t) => {
  const requestId = 'serializable-request';
  const abortController = new AbortController();
  const signal = abortController.signal;
  // A live signal can carry application state that cannot be serialized.
  Object.assign(signal, { details: { signal } });

  const service = nexus.service(SERVICE, {
    [OPERATION]: nexus.operation<void, { info: ReturnType<typeof operationInfo> }>(),
  });
  const handler = nexus.serviceHandler(service, {
    [OPERATION]: {
      async start() {
        const info = operationInfo();
        t.is(info.cancellationSignal, signal);
        return nexus.HandlerStartOperationResult.sync({ info });
      },
      async cancel() {},
    },
  });
  const worker = makeHandler(new Map([[SERVICE, handler]]), { abortController, dataConverter: {} });
  const completion = await worker.run({
    taskToken: worker.taskToken,
    request: { endpoint: ENDPOINT, startOperation: { service: SERVICE, operation: OPERATION, requestId } },
  });
  const payload = completion.completed?.startOperation?.syncSuccess?.payload;
  t.truthy(payload, 'the worker must serialize operation info in a synchronous response');
  if (payload == null) return;
  t.deepEqual(defaultPayloadConverter.fromPayload(payload), {
    info: {
      namespace: 'default',
      taskQueue: 'my-task-queue',
      endpoint: ENDPOINT,
      service: SERVICE,
      operation: OPERATION,
      requestId,
    },
  });
});

for (const method of ['start', 'cancel'] as const) {
  for (const source of ['interceptor', 'worker'] as const) {
    test(`Nexus ${method} observes ${source} cancellation through a forwarded signal`, async (t) => {
      const abortController = new AbortController();
      const interceptorController = new AbortController();
      const workerSignal = abortController.signal;
      const forwardedSignal = AbortSignal.any([workerSignal, interceptorController.signal]);
      const reason = new Error(`cancelled by the ${source}`);
      const requestId = 'original-request-id';
      const expectedRequestId = method === 'start' ? requestId : undefined;

      const observeCancellation = async () => {
        const { cancellationSignal } = operationInfo();
        t.is(cancellationSignal, forwardedSignal);
        t.is(operationInfo().requestId, expectedRequestId);
        t.false(cancellationSignal.aborted);
        let observedReason: unknown;
        cancellationSignal.addEventListener('abort', () => (observedReason = cancellationSignal.reason), {
          once: true,
        });

        await Promise.resolve();
        (source === 'interceptor' ? interceptorController : abortController).abort(reason);
        t.is(observedReason, reason);
        t.is(cancellationSignal.reason, reason);
        t.is(workerSignal.aborted, source === 'worker');
      };
      const service = nexus.service(SERVICE, { [OPERATION]: nexus.operation<void, void>() });
      const handler = nexus.serviceHandler(service, {
        [OPERATION]: new TemporalOperationHandler<void, void>({
          async start() {
            await observeCancellation();
            return TemporalOperationResult.sync(undefined);
          },
          cancelWorkflowRun: observeCancellation,
        }),
      });
      const worker = makeHandler(new Map([[SERVICE, handler]]), {
        abortController,
        headers: { 'x-test': 'interceptor-header' },
        onClientAbortSignal: (signal) => t.is(signal, workerSignal),
        interceptors: [
          () => ({
            inbound: {
              async startOperation(input, next) {
                t.is(input.ctx.headers['x-test'], 'interceptor-header');
                t.is(operationInfo().cancellationSignal, workerSignal);
                const output = await next({
                  ...input,
                  ctx: { ...input.ctx, requestId: 'forwarded-request-id', abortSignal: forwardedSignal },
                });
                t.is(operationInfo().cancellationSignal, workerSignal);
                return output;
              },
              async cancelOperation(input, next) {
                t.is(input.ctx.headers['x-test'], 'interceptor-header');
                t.is(operationInfo().cancellationSignal, workerSignal);
                await next({ ...input, ctx: { ...input.ctx, abortSignal: forwardedSignal } });
                t.is(operationInfo().cancellationSignal, workerSignal);
              },
            },
          }),
        ],
      });
      const completion = await worker.run({
        taskToken: worker.taskToken,
        request: {
          endpoint: ENDPOINT,
          ...(method === 'start'
            ? { startOperation: { service: SERVICE, operation: OPERATION, requestId } }
            : {
                cancelOperation: {
                  service: SERVICE,
                  operation: OPERATION,
                  operationToken: generateWorkflowRunOperationToken('default', 'backing-workflow'),
                },
              }),
        },
      });
      if (method === 'start') {
        t.truthy(completion.completed?.startOperation?.syncSuccess);
      } else {
        t.truthy(completion.completed?.cancelOperation);
      }
      t.throws(operationInfo, { instanceOf: ReferenceError });
    });
  }
}

test('concurrent Nexus handlers receive only their own invocation information', async (t) => {
  const output = makeContextTrace('wrapped');
  const service = nexus.service(SERVICE, { [OPERATION]: nexus.operation<void, typeof output>() });
  const firstRequestId = 'opaque/request-1';
  const secondRequestId = 'opaque/request-2';
  const firstController = new AbortController();
  const secondController = new AbortController();
  const earlyCancellation = new Error('the first task was already canceled');
  firstController.abort(earlyCancellation);

  let arrivals = 0;
  let release!: () => void;
  const bothRunning = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = nexus.serviceHandler(service, {
    [OPERATION]: new TemporalOperationHandler<void, typeof output>({
      async start() {
        const info = operationInfo();
        if (++arrivals === 2) release();
        await bothRunning;

        t.deepEqual(operationInfo(), info);
        t.is(info.namespace, 'default');
        t.is(info.taskQueue, 'my-task-queue');
        t.is(info.endpoint, ENDPOINT);
        t.is(info.service, SERVICE);
        t.is(info.operation, OPERATION);
        t.false('headers' in info);
        t.false('callbackUrl' in info);
        t.false('requestDeadline' in info);
        if (info.requestId === firstRequestId) {
          t.is(info.cancellationSignal, firstController.signal);
          t.true(info.cancellationSignal.aborted);
          t.throws(() => info.cancellationSignal.throwIfAborted(), { is: earlyCancellation });
        } else {
          t.is(info.requestId, secondRequestId);
          t.is(info.cancellationSignal, secondController.signal);
          t.false(info.cancellationSignal.aborted);
        }
        return TemporalOperationResult.sync({ ...output, trace: [] });
      },
    }),
  });
  const interceptedRequestIds = new Set<string>();
  const run = (requestId: string, abortController: AbortController) =>
    makeHandler(new Map([[SERVICE, handler]]), {
      abortController,
      headers: { 'x-test': requestId },
      interceptors: [
        () => ({
          inbound: {
            async startOperation(input, next) {
              interceptedRequestIds.add(input.ctx.requestId);
              t.is(input.ctx.headers['x-test'], requestId);
              t.is(input.ctx.abortSignal, abortController.signal);
              t.is(operationInfo().requestId, input.ctx.requestId);
              return next(input);
            },
          },
        }),
      ],
    }).run({
      taskToken: new Uint8Array([1, 2, 3]),
      request: { endpoint: ENDPOINT, startOperation: { service: SERVICE, operation: OPERATION, requestId } },
    });

  const completions = await Promise.all([run(firstRequestId, firstController), run(secondRequestId, secondController)]);
  t.deepEqual(interceptedRequestIds, new Set([firstRequestId, secondRequestId]));
  t.throws(operationInfo, { instanceOf: ReferenceError });
  for (const completion of completions) {
    const result = completion.completed?.startOperation;
    t.is(result?.asyncSuccess, undefined);
    const payload = result?.syncSuccess?.payload;
    t.truthy(payload, 'the worker must encode the result in a synchronous response');
    if (payload == null) continue;
    t.deepEqual(defaultPayloadConverter.fromPayload(payload), {
      ...output,
      trace: [enc(output.label, nexusCtx(ENDPOINT, SERVICE, OPERATION))],
    });
  }
});
