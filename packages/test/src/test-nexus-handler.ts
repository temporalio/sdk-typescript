import { randomUUID } from 'node:crypto';
import anyTest, { TestFn } from 'ava';
import Long from 'long';
import * as nexus from 'nexus-rpc';
import * as protoJsonSerializer from 'proto3-json-serializer';
import * as temporalnexus from '@temporalio/nexus';
import * as temporalclient from '@temporalio/client';
import * as root from '@temporalio/proto';
import * as testing from '@temporalio/testing';
import { DefaultLogger, LogEntry, Runtime, Worker } from '@temporalio/worker';
import {
  ApplicationFailure,
  CancelledFailure,
  defaultFailureConverter,
  defaultPayloadConverter,
  SdkComponent,
} from '@temporalio/common';
import {
  convertWorkflowEventLinkToNexusLink,
  convertNexusLinkToWorkflowEventLink,
} from '@temporalio/nexus/lib/link-converter';
import { isBun, cleanStackTrace, compareStackTrace, getRandomPort } from './helpers';

export interface Context {
  httpPort: number;
  taskQueue: string;
  endpoint: testing.NexusEndpointIdentifier;
  env: testing.TestWorkflowEnvironment;
  logEntries: LogEntry[];
}

const test = anyTest as TestFn<Context>;

test.before(async (t) => {
  const logEntries = new Array<LogEntry>();

  const logger = new DefaultLogger('INFO', (entry) => {
    logEntries.push(entry);
  });

  Runtime.install({ logger });
  t.context.httpPort = await getRandomPort();
  t.context.env = await testing.TestWorkflowEnvironment.createLocal({
    server: {
      extraArgs: [
        '--http-port',
        `${t.context.httpPort}`,
        // SDK tests use arbitrary callback URLs, permit that on the server.
        '--dynamic-config-value',
        'component.callbacks.allowedAddresses=[{"Pattern":"*","AllowInsecure":true}]',
        // TODO: remove this config when it becomes the default on the server.
        '--dynamic-config-value',
        'history.enableRequestIdRefLinks=true',
      ],
    },
  });
  t.context.logEntries = logEntries;
});

test.after.always(async (t) => {
  await t.context.env.teardown();
});

test.beforeEach(async (t) => {
  const taskQueue = t.title + randomUUID();
  const { env } = t.context;
  const endpointName = taskQueue.replaceAll(/[\s,.]/g, '-');
  const endpoint = await env.createNexusEndpoint(endpointName, taskQueue);

  t.context.taskQueue = taskQueue;
  t.context.endpoint = endpoint;
});

test.afterEach(async (t) => {
  const { env, endpoint } = t.context;
  await env.deleteNexusEndpoint(endpoint);
});

test('sync Operation Handler happy path', async (t) => {
  const { env, taskQueue, httpPort, endpoint } = t.context;
  const endpointId = endpoint.id;

  const testServiceHandler = nexus.serviceHandler(
    nexus.service('testService', {
      testSyncOp: nexus.operation<string, string>(),
    }),
    {
      async testSyncOp(ctx, input) {
        // Testing headers normalization to lower case.
        if (ctx.headers.Test !== 'true') {
          throw new nexus.HandlerError('BAD_REQUEST', 'expected test header to be set to true');
        }
        // Echo links back to the caller.
        ctx.outboundLinks.push(...ctx.inboundLinks);
        return input;
      },
    }
  );

  const w = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    nexusServices: [testServiceHandler],
  });

  await w.runUntil(async () => {
    const res = await fetch(
      `http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testSyncOp`,
      {
        method: 'POST',
        body: JSON.stringify('hello'),
        headers: {
          'Content-Type': 'application/json',
          Test: 'true',
          'Nexus-Link': '<http://test/>; type="test"',
        },
      }
    );
    t.true(res.ok);
    const output = await res.json();
    t.is(output, 'hello');
    t.is(res.headers.get('Nexus-Link'), '<http://test/>; type="test"');
  });
});

test('Operation Handler cancellation', async (t) => {
  const { env, taskQueue, httpPort, endpoint } = t.context;
  const endpointId = endpoint.id;
  let p: Promise<never> | undefined;

  const w = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    nexusServices: [
      nexus.serviceHandler(
        nexus.service('testService', {
          testSyncOp: nexus.operation<void, void>(),
        }),
        {
          async testSyncOp(ctx) {
            p = new Promise((_, reject) => {
              ctx.abortSignal.onabort = () => {
                reject(ctx.abortSignal.reason);
              };
              // never resolve this promise.
            });
            return await p;
          },
        }
      ),
    ],
  });

  await w.runUntil(async () => {
    const res = await fetch(
      `http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testSyncOp`,
      {
        method: 'POST',
        headers: {
          'Request-Timeout': '2s',
        },
      }
    );
    t.is(res.status, 520 /* UPSTREAM_TIMEOUT */);
    // Give time for the worker to actually process the timeout; otherwise the Operation
    // may end up being cancelled because of the worker shutdown rather than the timeout.
    await Promise.race([
      p?.catch(() => undefined),
      new Promise((resolve) => {
        setTimeout(resolve, 2000).unref();
      }),
    ]);
  });
  t.truthy(p);
  await t.throwsAsync(p!, { instanceOf: CancelledFailure, message: 'TIMED_OUT' });
});

test('async Operation Handler happy path', async (t) => {
  const { env, taskQueue, httpPort, endpoint } = t.context;
  const endpointId = endpoint.id;
  const requestId = 'test-' + randomUUID();

  const w = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    nexusServices: [
      nexus.serviceHandler(
        nexus.service('testService', {
          // Also test custom Operation name.
          testAsyncOp: nexus.operation<string, string>({ name: 'async-op' }),
        }),
        {
          testAsyncOp: {
            async start(ctx, input): Promise<nexus.HandlerStartOperationResult<string>> {
              if (input !== 'hello') {
                throw new nexus.HandlerError('BAD_REQUEST', 'expected input to equal "hello"');
              }
              if (ctx.headers.test !== 'true') {
                throw new nexus.HandlerError('BAD_REQUEST', 'expected test header to be set to true');
              }
              if (!ctx.requestId) {
                throw new nexus.HandlerError('BAD_REQUEST', 'expected requestId to be set');
              }
              return nexus.HandlerStartOperationResult.async(ctx.requestId);
            },
            async cancel(ctx, token) {
              if (ctx.headers.test !== 'true') {
                throw new nexus.HandlerError('BAD_REQUEST', 'expected test header to be set to true');
              }
              if (token !== requestId) {
                throw new nexus.HandlerError('BAD_REQUEST', 'expected token to equal original requestId');
              }
            },
            async getInfo() {
              throw new Error('not implemented');
            },
            async getResult() {
              throw new Error('not implemented');
            },
          },
        }
      ),
    ],
  });

  await w.runUntil(async () => {
    let res = await fetch(`http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/async-op`, {
      method: 'POST',
      body: JSON.stringify('hello'),
      headers: {
        'Content-Type': 'application/json',
        'Nexus-Request-Id': requestId,
        Test: 'true',
      },
    });
    t.true(res.ok);
    const output = (await res.json()) as { token: string; state: nexus.OperationState };

    t.is(output.token, requestId);
    t.is(output.state, 'running');

    res = await fetch(
      `http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/async-op/cancel`,
      {
        method: 'POST',
        headers: {
          'Nexus-Operation-Token': output.token,
          Test: 'true',
        },
      }
    );
    t.true(res.ok);
  });
});

test('start Operation Handler errors', async (t) => {
  const { env, taskQueue, httpPort, endpoint } = t.context;
  const endpointId = endpoint.id;

  const w = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    nexusServices: [
      nexus.serviceHandler(
        nexus.service('testService', {
          op: nexus.operation<string, string>(),
        }),
        {
          async op(_ctx, outcome) {
            switch (outcome) {
              case 'NonRetryableApplicationFailure':
                throw ApplicationFailure.create({
                  nonRetryable: true,
                  message: 'deliberate failure',
                  details: ['details'],
                });
              case 'NonRetryableInternalHandlerError':
                throw new nexus.HandlerError('INTERNAL', 'deliberate error', { retryableOverride: false });
              case 'OperationError':
                throw new nexus.OperationError('failed', 'deliberate error');
            }
            throw new nexus.HandlerError('BAD_REQUEST', 'invalid outcome requested');
          },
        }
      ),
    ],
  });

  await w.runUntil(async () => {
    {
      const res = await fetch(`http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op`, {
        method: 'POST',
        body: JSON.stringify('NonRetryableApplicationFailure'),
        headers: {
          'Content-Type': 'application/json',
        },
      });
      t.is(res.status, 500);
      const failure = (await res.json()) as any;
      const failureType = (root as any).lookupType('temporal.api.failure.v1.Failure');
      const temporalFailure = protoJsonSerializer.fromProto3JSON(failureType, failure.details);
      const err = defaultFailureConverter.failureToError(temporalFailure as any, defaultPayloadConverter);
      delete failure.details;

      t.deepEqual(failure, {
        message: 'deliberate failure',
        metadata: {
          type: 'temporal.api.failure.v1.Failure',
        },
      });
      t.true(err instanceof ApplicationFailure);
      t.is(err.message, '');
      compareStackTrace(
        t,
        cleanStackTrace(err.stack!),
        isBun
          ? `ApplicationFailure: deliberate failure
    at create (common/lib/failure.js)
    at op (test/lib/test-nexus-handler.js)
    at <anonymous> (nexus-rpc/lib/handler/operation-handler.js)
    at start (nexus-rpc/lib/handler/service-registry.js)
    at processTicksAndRejections (native)`
          : `ApplicationFailure: deliberate failure
    at $CLASS.create (common/src/failure.ts)
    at op (test/src/test-nexus-handler.ts)
    at Object.start (nexus-rpc/src/handler/operation-handler.ts)
    at ServiceRegistry.start (nexus-rpc/src/handler/service-registry.ts)`
      );
      t.deepEqual((err as ApplicationFailure).details, ['details']);
      t.is((err as ApplicationFailure).failure?.source, 'TypeScriptSDK');
    }
    {
      const res = await fetch(`http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op`, {
        method: 'POST',
        body: JSON.stringify('NonRetryableInternalHandlerError'),
        headers: {
          'Content-Type': 'application/json',
        },
      });
      t.is(res.status, 500);
      t.is(res.headers.get('Nexus-Request-Retryable'), 'false');
      const failure = (await res.json()) as any;
      const failureType = (root as any).lookupType('temporal.api.failure.v1.Failure');
      const temporalFailure = protoJsonSerializer.fromProto3JSON(failureType, failure.details);
      const err = defaultFailureConverter.failureToError(temporalFailure as any, defaultPayloadConverter);
      delete failure.details;
      t.true(err instanceof Error);
      t.is(err.message, '');
      t.deepEqual(
        cleanStackTrace(err.stack!),
        isBun
          ? `HandlerError: deliberate error
    at op (test/lib/test-nexus-handler.js)
    at <anonymous> (nexus-rpc/lib/handler/operation-handler.js)
    at start (nexus-rpc/lib/handler/service-registry.js)
    at processTicksAndRejections (native)`
          : `HandlerError: deliberate error
    at op (test/src/test-nexus-handler.ts)
    at Object.start (nexus-rpc/src/handler/operation-handler.ts)
    at ServiceRegistry.start (nexus-rpc/src/handler/service-registry.ts)`
      );
    }
    {
      const res = await fetch(`http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op`, {
        method: 'POST',
        body: JSON.stringify('OperationError'),
        headers: {
          'Content-Type': 'application/json',
        },
      });
      t.is(res.status, 424 /* As defined in the nexus HTTP spec */);
      const failure = (await res.json()) as any;
      const failureType = (root as any).lookupType('temporal.api.failure.v1.Failure');
      const temporalFailure = protoJsonSerializer.fromProto3JSON(failureType, failure.details);
      const err = defaultFailureConverter.failureToError(temporalFailure as any, defaultPayloadConverter);
      delete failure.details;
      t.true(err instanceof Error);
      t.is(err.message, '');
      t.is(res.headers.get('nexus-operation-state'), 'failed');
      compareStackTrace(
        t,
        cleanStackTrace(err.stack!),
        isBun
          ? `OperationError: deliberate error
    at op (test/lib/test-nexus-handler.js)
    at <anonymous> (nexus-rpc/lib/handler/operation-handler.js)
    at start (nexus-rpc/lib/handler/service-registry.js)
    at processTicksAndRejections (native)`
          : `OperationError: deliberate error
    at op (test/src/test-nexus-handler.ts)
    at Object.start (nexus-rpc/src/handler/operation-handler.ts)
    at ServiceRegistry.start (nexus-rpc/src/handler/service-registry.ts)`
      );
    }
    {
      const res = await fetch(`http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op`, {
        method: 'POST',
        body: 'invalid',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      t.is(res.status, 400);
      const { message } = (await res.json()) as { message: string };
      // Exact error message varies between Node versions and runtimes.
      t.regex(
        message,
        isBun
          ? /Failed to deserialize input: SyntaxError: JSON Parse error:/
          : /Failed to deserialize input: SyntaxError: Unexpected token .* JSON/
      );
    }
  });
});

test('cancel Operation Handler errors', async (t) => {
  const { env, taskQueue, httpPort, endpoint } = t.context;
  const endpointId = endpoint.id;

  const w = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    nexusServices: [
      nexus.serviceHandler(
        nexus.service('testService', {
          op: nexus.operation<void, void>(),
        }),
        {
          op: {
            async start() {
              throw new Error('not implemented');
            },
            async cancel(ctx, _token) {
              switch (ctx.headers.outcome) {
                case 'NonRetryableApplicationFailure':
                  throw ApplicationFailure.create({
                    nonRetryable: true,
                    message: 'deliberate failure',
                    details: ['details'],
                  });
                case 'NonRetryableInternalHandlerError':
                  throw new nexus.HandlerError('INTERNAL', 'deliberate error', { retryableOverride: false });
              }
              throw new nexus.HandlerError('BAD_REQUEST', 'invalid outcome requested');
            },
            async getInfo() {
              throw new Error('not implemented');
            },
            async getResult() {
              throw new Error('not implemented');
            },
          },
        }
      ),
    ],
  });

  await w.runUntil(async () => {
    {
      const res = await fetch(
        `http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op/cancel`,
        {
          method: 'POST',
          headers: {
            'Nexus-Operation-Token': 'token',
            Outcome: 'NonRetryableApplicationFailure',
          },
        }
      );
      t.is(res.status, 500);
      const failure = (await res.json()) as any;
      const failureType = (root as any).lookupType('temporal.api.failure.v1.Failure');
      const temporalFailure = protoJsonSerializer.fromProto3JSON(failureType, failure.details);
      const err = defaultFailureConverter.failureToError(temporalFailure as any, defaultPayloadConverter);
      delete failure.details;

      t.deepEqual(failure, {
        message: 'deliberate failure',
        metadata: {
          type: 'temporal.api.failure.v1.Failure',
        },
      });
      t.true(err instanceof ApplicationFailure);
      t.is(err.message, '');
      compareStackTrace(
        t,
        cleanStackTrace(err.stack!),
        isBun
          ? `ApplicationFailure: deliberate failure
    at create (common/lib/failure.js)
    at cancel (test/lib/test-nexus-handler.js)
    at cancel (nexus-rpc/lib/handler/service-registry.js)
    at invokeUserCode (worker/lib/nexus/index.js)
    at cancelOperation (worker/lib/nexus/index.js)
    at execute (worker/lib/nexus/index.js)
    at <anonymous> (worker/lib/nexus/index.js)
    at withAbortSignal (worker/lib/connection.js)`
          : `ApplicationFailure: deliberate failure
    at $CLASS.create (common/src/failure.ts)
    at Object.cancel (test/src/test-nexus-handler.ts)
    at ServiceRegistry.cancel (nexus-rpc/src/handler/service-registry.ts)`
      );
      t.deepEqual((err as ApplicationFailure).details, ['details']);
      t.is((err as ApplicationFailure).failure?.source, 'TypeScriptSDK');
    }
    {
      const res = await fetch(
        `http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op/cancel`,
        {
          method: 'POST',
          headers: {
            'Nexus-Operation-Token': 'token',
            Outcome: 'NonRetryableInternalHandlerError',
          },
        }
      );
      t.is(res.status, 500);
      t.is(res.headers.get('Nexus-Request-Retryable'), 'false');
      const failure = (await res.json()) as any;
      const failureType = (root as any).lookupType('temporal.api.failure.v1.Failure');
      const temporalFailure = protoJsonSerializer.fromProto3JSON(failureType, failure.details);
      const err = defaultFailureConverter.failureToError(temporalFailure as any, defaultPayloadConverter);
      delete failure.details;
      t.true(err instanceof Error);
      t.is(err.message, '');
      compareStackTrace(
        t,
        cleanStackTrace(err.stack!),
        isBun
          ? `HandlerError: deliberate error
    at cancel (test/lib/test-nexus-handler.js)
    at cancel (nexus-rpc/lib/handler/service-registry.js)
    at invokeUserCode (worker/lib/nexus/index.js)
    at cancelOperation (worker/lib/nexus/index.js)
    at execute (worker/lib/nexus/index.js)
    at <anonymous> (worker/lib/nexus/index.js)
    at withAbortSignal (worker/lib/connection.js)
    at withAbortSignal (client/lib/base-client.js)`
          : `HandlerError: deliberate error
    at Object.cancel (test/src/test-nexus-handler.ts)
    at ServiceRegistry.cancel (nexus-rpc/src/handler/service-registry.ts)`
      );
    }
  });
});

test('logger is available in handler context', async (t) => {
  const { env, taskQueue, httpPort, endpoint, logEntries } = t.context;
  const endpointId = endpoint.id;

  const w = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    nexusServices: [
      nexus.serviceHandler(
        nexus.service('testService', {
          testSyncOp: nexus.operation<string, string>(),
        }),
        {
          async testSyncOp(_ctx, input) {
            temporalnexus.log.info('handler ran', { input });
            return input;
          },
        }
      ),
    ],
  });

  await w.runUntil(async () => {
    const res = await fetch(
      `http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testSyncOp`,
      {
        method: 'POST',
        body: JSON.stringify('hello'),
        headers: { 'Content-Type': 'application/json' },
      }
    );
    t.true(res.ok);
    const output = await res.json();
    t.is(output, 'hello');
  });

  const entries = logEntries.filter(({ meta }) => meta?.sdkComponent === SdkComponent.nexus);
  t.is(entries.length, 1);
  t.is(entries[0].message, 'handler ran');
  t.deepEqual(entries[0].meta, {
    sdkComponent: SdkComponent.nexus,
    namespace: env.namespace ?? 'default',
    service: 'testService',
    operation: 'testSyncOp',
    taskQueue,
    input: 'hello',
  });
});

test('getClient is available in handler context', async (t) => {
  const { env, taskQueue, httpPort, endpoint } = t.context;
  const endpointId = endpoint.id;

  const w = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    nexusServices: [
      nexus.serviceHandler(
        nexus.service('testService', {
          testSyncOp: nexus.operation<void, boolean>(),
        }),
        {
          async testSyncOp() {
            const systemInfo = await temporalnexus
              .getClient()
              .connection.workflowService.getSystemInfo({ namespace: 'default' });
            return systemInfo.capabilities?.nexus ?? false;
          },
        }
      ),
    ],
  });

  await w.runUntil(async () => {
    const res = await fetch(
      `http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testSyncOp`,
      {
        method: 'POST',
      }
    );
    t.true(res.ok);
    const output = await res.json();
    t.is(output, true);
  });
});

test('operationInfo is available in handler context', async (t) => {
  const { env, taskQueue, httpPort, endpoint } = t.context;
  const endpointId = endpoint.id;

  const w = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    nexusServices: [
      nexus.serviceHandler(
        nexus.service('testService', {
          testSyncOp: nexus.operation<void, { namespace: string; taskQueue: string }>(),
        }),
        {
          async testSyncOp() {
            const info = temporalnexus.operationInfo();
            return {
              namespace: info.namespace,
              taskQueue: info.taskQueue,
            };
          },
        }
      ),
    ],
  });

  await w.runUntil(async () => {
    const res = await fetch(
      `http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testSyncOp`,
      {
        method: 'POST',
      }
    );
    t.true(res.ok);
    const output = (await res.json()) as { namespace: string; taskQueue: string };
    t.is(output.namespace, 'default');
    t.is(output.taskQueue, taskQueue);
  });
});

test('WorkflowRunOperationHandler attaches callback, link, and request ID', async (t) => {
  const { env, taskQueue, httpPort, endpoint } = t.context;
  const endpointId = endpoint.id;

  const requestId1 = randomUUID();
  const requestId2 = randomUUID();
  const workflowId = t.title;

  const w = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    nexusServices: [
      nexus.serviceHandler(
        nexus.service('testService', {
          testOp: nexus.operation<void, void>(),
        }),
        {
          testOp: new temporalnexus.WorkflowRunOperationHandler<void, void>(async (ctx) => {
            return await temporalnexus.startWorkflow(ctx, 'some-workflow', {
              workflowId,
              // To test attaching multiple callers to the same Operation.
              workflowIdConflictPolicy: 'USE_EXISTING',
            });
          }),
        }
      ),
    ],
  });

  const callbackURL = 'http://not-found';
  const workflowLink = {
    namespace: 'default',
    workflowId: 'wid',
    runId: 'runId',
    eventRef: {
      eventId: Long.fromNumber(5),
      eventType: root.temporal.api.enums.v1.EventType.EVENT_TYPE_NEXUS_OPERATION_SCHEDULED,
    },
  };
  const nexusLink = convertWorkflowEventLinkToNexusLink(workflowLink);

  await w.runUntil(async () => {
    const backlinks = [];
    for (const requestId of [requestId1, requestId2]) {
      const endpointUrl = new URL(
        `http://127.0.0.1:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testOp`
      );
      endpointUrl.searchParams.set('callback', callbackURL);
      const res = await fetch(endpointUrl.toString(), {
        method: 'POST',
        body: JSON.stringify('hello'),
        headers: {
          'Content-Type': 'application/json',
          'Nexus-Request-Id': requestId,
          'Nexus-Callback-Token': 'token',
          'Nexus-Link': `<${nexusLink.url}>; type="${nexusLink.type}"`,
        },
      });
      t.true(res.ok);
      const output = (await res.json()) as { token: string; state: nexus.OperationState };
      t.is(output.state, 'running');
      console.log(res.headers.get('Nexus-Link'));
      const m = /<([^>]+)>; type="([^"]+)"/.exec(res.headers.get('Nexus-Link') ?? '');
      t.truthy(m);
      const [_, url, type] = m!;
      const backlink = convertNexusLinkToWorkflowEventLink({ url: new URL(url), type });
      backlinks.push(backlink);
    }

    t.is(backlinks[0].eventRef?.eventType, root.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED);
    t.deepEqual(backlinks[0].eventRef?.eventId, Long.fromNumber(1));
    t.is(backlinks[0].workflowId, workflowId);

    console.log(backlinks[1]);
    t.is(
      backlinks[1].requestIdRef?.eventType,
      root.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_OPTIONS_UPDATED
    );
    t.deepEqual(backlinks[1].requestIdRef?.requestId, requestId2);
    t.is(backlinks[1].workflowId, workflowId);
  });

  const description = await env.client.workflow.getHandle(workflowId).describe();
  // Ensure that request IDs are propagated.
  t.truthy(description.raw.workflowExtendedInfo?.requestIdInfos?.[requestId1]);
  t.truthy(description.raw.workflowExtendedInfo?.requestIdInfos?.[requestId2]);

  // Ensure that callbacks are attached.
  t.is(description.raw.callbacks?.length, 2);
  // Don't bother verifying the second callback.
  const callback = description.raw.callbacks?.[0].callback;
  t.is(callback?.nexus?.url, callbackURL);
  t.deepEqual(callback?.nexus?.header, { token: 'token' });
  t.is(callback?.links?.length, 1);
  const actualLink = callback!.links![0]!.workflowEvent;

  t.deepEqual(actualLink?.namespace, workflowLink.namespace);
  t.deepEqual(actualLink?.workflowId, workflowLink.workflowId);
  t.deepEqual(actualLink?.runId, workflowLink.runId);
  t.deepEqual(actualLink?.eventRef?.eventType, workflowLink.eventRef.eventType);
  t.deepEqual(actualLink?.eventRef?.eventId, workflowLink.eventRef.eventId);
});

test('WorkflowRunOperationHandler does not accept WorkflowHandle from WorkflowClient.start', async (t) => {
  // Dummy client, it won't actually be called.
  const client: temporalclient.WorkflowClient = undefined as any;

  nexus.serviceHandler(
    nexus.service('testService', {
      syncOperation: nexus.operation<void, void>(),
    }),
    {
      syncOperation: new temporalnexus.WorkflowRunOperationHandler<void, void>(
        // @ts-expect-error - Missing property [isNexusWorkflowHandle]
        async (_ctx) => {
          return await client.start('some-workflow', {
            workflowId: 'some-workflow',
            taskQueue: 'some-task-queue',
          });
        }
      ),
    }
  );

  // This test only checks for compile-time error.
  t.pass();
});

test('createNexusEndpoint and deleteNexusEndpoint', async (t) => {
  const { env } = t.context;
  const taskQueue = 'test-delete-endpoint-' + randomUUID();
  const endpointName = 'test-delete-endpoint-' + randomUUID();

  // Create an endpoint
  const endpoint = await env.createNexusEndpoint(endpointName, taskQueue);
  t.truthy(endpoint.id);
  t.truthy(endpoint.version);
  t.is(endpoint.raw.spec?.name, endpointName);

  // Delete the endpoint
  await env.deleteNexusEndpoint(endpoint);
  t.pass();
});
