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
      const checkContext = source === 'interceptor';

      const observeCancellation = () => {
        const info = operationInfo();
        const { cancellationSignal } = info;
        t.is(cancellationSignal, forwardedSignal);
        if (checkContext) t.is(info.requestId, method === 'start' ? requestId : undefined);
        t.false(cancellationSignal.aborted);
        let observedReason: unknown;
        cancellationSignal.addEventListener('abort', () => (observedReason = cancellationSignal.reason), {
          once: true,
        });

        (source === 'interceptor' ? interceptorController : abortController).abort(reason);
        t.is(observedReason, reason);
        t.is(workerSignal.aborted, source === 'worker');
      };
      const service = nexus.service(SERVICE, { [OPERATION]: nexus.operation<void, void>() });
      const handler = nexus.serviceHandler(service, {
        [OPERATION]: new TemporalOperationHandler<void, void>({
          async start() {
            observeCancellation();
            return TemporalOperationResult.sync(undefined);
          },
          async cancelWorkflowRun() {
            observeCancellation();
          },
        }),
      });
      const worker = makeHandler(new Map([[SERVICE, handler]]), {
        abortController,
        headers: { 'x-test': 'interceptor-header' },
        onClientAbortSignal: checkContext ? (signal) => t.is(signal, workerSignal) : undefined,
        interceptors: [
          () => ({
            inbound: {
              async startOperation(input, next) {
                if (checkContext) {
                  t.is(input.ctx.headers['x-test'], 'interceptor-header');
                  t.is(operationInfo().cancellationSignal, workerSignal);
                }
                const output = await next({
                  ...input,
                  ctx: { ...input.ctx, requestId: 'forwarded-request-id', abortSignal: forwardedSignal },
                });
                if (checkContext) t.is(operationInfo().cancellationSignal, workerSignal);
                return output;
              },
              async cancelOperation(input, next) {
                if (checkContext) {
                  t.is(input.ctx.headers['x-test'], 'interceptor-header');
                  t.is(operationInfo().cancellationSignal, workerSignal);
                }
                await next({ ...input, ctx: { ...input.ctx, abortSignal: forwardedSignal } });
                if (checkContext) t.is(operationInfo().cancellationSignal, workerSignal);
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
      if (checkContext) t.throws(operationInfo, { instanceOf: ReferenceError });
    });
  }
}

test('concurrent Nexus handlers keep their own request ID and cancellation signal', async (t) => {
  const invocations = [
    { requestId: 'opaque/request-1', abortController: new AbortController() },
    { requestId: 'opaque/request-2', abortController: new AbortController() },
  ];
  const earlyCancellation = new Error('the first task was already canceled');
  invocations[0].abortController.abort(earlyCancellation);

  let arrivals = 0;
  let release!: () => void;
  const bothRunning = new Promise<void>((resolve) => {
    release = resolve;
  });

  const service = nexus.service(SERVICE, { [OPERATION]: nexus.operation<number, void>() });
  const handler = nexus.serviceHandler(service, {
    [OPERATION]: new TemporalOperationHandler<number, void>({
      async start(_client, input) {
        if (++arrivals === invocations.length) release();
        await bothRunning;

        const expected = invocations[input];
        const info = operationInfo();
        t.is(info.requestId, expected.requestId);
        t.is(info.cancellationSignal, expected.abortController.signal);
        if (input === 0) {
          t.throws(() => info.cancellationSignal.throwIfAborted(), { is: earlyCancellation });
        } else {
          t.false(info.cancellationSignal.aborted);
        }
        return TemporalOperationResult.sync(undefined);
      },
    }),
  });

  await Promise.all(
    invocations.map(async ({ requestId, abortController }, input) => {
      const worker = makeHandler(new Map([[SERVICE, handler]]), { abortController, dataConverter: {} });
      const completion = await worker.run({
        taskToken: worker.taskToken,
        request: {
          endpoint: ENDPOINT,
          startOperation: {
            service: SERVICE,
            operation: OPERATION,
            requestId,
            payload: defaultPayloadConverter.toPayload(input),
          },
        },
      });
      t.truthy(completion.completed?.startOperation?.syncSuccess);
    })
  );
});
