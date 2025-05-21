// TODO: Remove /Users/bergundy/... for stack traces, requires publishing nexus-rpc.

import { randomUUID } from 'node:crypto';
import anyTest, { TestFn } from 'ava';
import getPort from 'get-port';
import Long from 'long';
import * as nexus from 'nexus-rpc';
import * as protoJsonSerializer from 'proto3-json-serializer';
import * as temporalnexus from '@temporalio/nexus';
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
import { cleanStackTrace } from './helpers';

export interface Context {
  httpPort: number;
  taskQueue: string;
  endpointId: string;
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
  t.context.httpPort = await getPort();
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
      executable: {
        type: 'cached-download',
        // TODO: remove this version override when CLI 1.4.0 is out.
        version: 'v1.3.1-nexus-links.0',
      },
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
  const response = await env.connection.operatorService.createNexusEndpoint({
    spec: {
      name: t.title.replaceAll(/[\s,]/g, '-'),
      target: {
        worker: {
          namespace: 'default',
          taskQueue,
        },
      },
    },
  });
  t.context.taskQueue = taskQueue;
  t.context.endpointId = response.endpoint!.id!;
  t.truthy(t.context.endpointId);
});

test('sync operation handler happy path', async (t) => {
  const { env, taskQueue, httpPort, endpointId } = t.context;

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
          async testSyncOp(input, options) {
            // Testing headers normalization to lower case.
            if (options.headers.Test !== 'true') {
              throw new nexus.HandlerError({ message: 'expected test header to be set to true', type: 'BAD_REQUEST' });
            }
            // Echo links back to the caller.
            nexus.handlerLinks().push(...options.links);
            return input;
          },
        }
      ),
    ],
  });

  await w.runUntil(async () => {
    const res = await fetch(
      `http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testSyncOp`,
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

test('operation handler cancelation', async (t) => {
  const { env, taskQueue, httpPort, endpointId } = t.context;
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
          async testSyncOp(_, options) {
            p = new Promise((_, reject) => {
              options.abortSignal.onabort = () => {
                reject(options.abortSignal.reason);
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
      `http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testSyncOp`,
      {
        method: 'POST',
        headers: {
          'Request-Timeout': '3s',
        },
      }
    );
    t.is(res.status, 520 /* UPSTREAM_TIMEOUT */);
  });
  t.truthy(p);
  await t.throwsAsync(p!, { instanceOf: CancelledFailure, message: 'TIMED_OUT' });
});

test('async operation handler happy path', async (t) => {
  const { env, taskQueue, httpPort, endpointId } = t.context;
  const requestId = 'test-' + randomUUID();

  const w = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    nexusServices: [
      nexus.serviceHandler(
        nexus.service('testService', {
          // Also test custom operation name.
          testAsyncOp: nexus.operation<string, string>({ name: 'async-op' }),
        }),
        {
          testAsyncOp: {
            async start(input, options): Promise<nexus.HandlerStartOperationResult<string>> {
              if (input !== 'hello') {
                throw new nexus.HandlerError({ message: 'expected input to equal "hello"', type: 'BAD_REQUEST' });
              }
              if (options.headers.test !== 'true') {
                throw new nexus.HandlerError({
                  message: 'expected test header to be set to true',
                  type: 'BAD_REQUEST',
                });
              }
              if (!options.requestId) {
                throw new nexus.HandlerError({ message: 'expected requestId to be set', type: 'BAD_REQUEST' });
              }
              return { token: options.requestId };
            },
            async cancel(token, options) {
              if (options.headers.test !== 'true') {
                throw new nexus.HandlerError({
                  message: 'expected test header to be set to true',
                  type: 'BAD_REQUEST',
                });
              }
              if (token !== requestId) {
                throw new nexus.HandlerError({
                  message: 'expected token to equal original requestId',
                  type: 'BAD_REQUEST',
                });
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
    let res = await fetch(`http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/async-op`, {
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
      `http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/async-op/cancel`,
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

test('start operation handler errors', async (t) => {
  const { env, taskQueue, httpPort, endpointId } = t.context;

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
          async op(outcome) {
            switch (outcome) {
              case 'NonRetryableApplicationFailure':
                throw ApplicationFailure.create({
                  nonRetryable: true,
                  message: 'deliberate failure',
                  details: ['details'],
                });
              case 'NonRetryableInternalHandlerError':
                throw new nexus.HandlerError({
                  type: 'INTERNAL',
                  message: 'deliberate error',
                  retryable: false,
                });
              case 'OperationError':
                throw new nexus.OperationError({
                  state: 'failed',
                  message: 'deliberate error',
                });
            }
            throw new nexus.HandlerError({
              type: 'BAD_REQUEST',
              message: 'invalid outcome requested',
            });
          },
        }
      ),
    ],
  });

  await w.runUntil(async () => {
    {
      const res = await fetch(`http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op`, {
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
      t.is(
        cleanStackTrace(err.stack!),
        `ApplicationFailure: deliberate failure
    at Function.create (common/src/failure.ts)
    at op (test/src/test-nexus-handler.ts)
    at ServiceRegistry.start (/Users/bergundy/temporal/nexus-sdk-typescript/src/operation.ts)`
      );
      t.deepEqual((err as ApplicationFailure).details, ['details']);
      t.is((err as ApplicationFailure).failure?.source, 'TypeScriptSDK');
    }
    {
      const res = await fetch(`http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op`, {
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
        `HandlerError: deliberate error
    at op (test/src/test-nexus-handler.ts)
    at ServiceRegistry.start (/Users/bergundy/temporal/nexus-sdk-typescript/src/operation.ts)`
      );
    }
    {
      const res = await fetch(`http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op`, {
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
      t.deepEqual(
        cleanStackTrace(err.stack!),
        `OperationError: deliberate error
    at op (test/src/test-nexus-handler.ts)
    at ServiceRegistry.start (/Users/bergundy/temporal/nexus-sdk-typescript/src/operation.ts)`
      );
    }
    {
      const res = await fetch(`http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op`, {
        method: 'POST',
        body: 'invalid',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      t.is(res.status, 400);
      const { message } = (await res.json()) as { message: string };
      t.is(message, 'Failed to deserialize input: SyntaxError: Unexpected token \'i\', "invalid" is not valid JSON');
    }
  });
});

test('cancel operation handler errors', async (t) => {
  const { env, taskQueue, httpPort, endpointId } = t.context;

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
            async cancel(_token, options) {
              switch (options.headers.outcome) {
                case 'NonRetryableApplicationFailure':
                  throw ApplicationFailure.create({
                    nonRetryable: true,
                    message: 'deliberate failure',
                    details: ['details'],
                  });
                case 'NonRetryableInternalHandlerError':
                  throw new nexus.HandlerError({
                    type: 'INTERNAL',
                    message: 'deliberate error',
                    retryable: false,
                  });
              }
              throw new nexus.HandlerError({
                type: 'BAD_REQUEST',
                message: 'invalid outcome requested',
              });
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
        `http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op/cancel`,
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
      t.is(
        cleanStackTrace(err.stack!),
        `ApplicationFailure: deliberate failure
    at Function.create (common/src/failure.ts)
    at Object.cancel (test/src/test-nexus-handler.ts)
    at ServiceRegistry.cancel (/Users/bergundy/temporal/nexus-sdk-typescript/src/operation.ts)`
      );
      t.deepEqual((err as ApplicationFailure).details, ['details']);
      t.is((err as ApplicationFailure).failure?.source, 'TypeScriptSDK');
    }
    {
      const res = await fetch(
        `http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/op/cancel`,
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
      t.deepEqual(
        cleanStackTrace(err.stack!),
        `HandlerError: deliberate error
    at Object.cancel (test/src/test-nexus-handler.ts)
    at ServiceRegistry.cancel (/Users/bergundy/temporal/nexus-sdk-typescript/src/operation.ts)`
      );
    }
  });
});

test('logger is available in handler context', async (t) => {
  const { env, taskQueue, httpPort, endpointId, logEntries } = t.context;

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
          async testSyncOp(input: string) {
            temporalnexus.log.info('handler ran', { input });
            return input;
          },
        }
      ),
    ],
  });

  await w.runUntil(async () => {
    const res = await fetch(
      `http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testSyncOp`,
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
    service: 'testService',
    operation: 'testSyncOp',
    taskQueue,
    input: 'hello',
  });
});

test('getClient is available in handler context', async (t) => {
  const { env, taskQueue, httpPort, endpointId } = t.context;

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
      `http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testSyncOp`,
      {
        method: 'POST',
      }
    );
    t.true(res.ok);
    const output = await res.json();
    t.is(output, true);
  });
});

test('WorkflowRunOperation attaches callback, link, and request ID', async (t) => {
  const { env, taskQueue, httpPort, endpointId } = t.context;
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
          testOp: new temporalnexus.WorkflowRunOperation<void, void>(async (_, options) => {
            return await temporalnexus.startWorkflow('some-workflow', options, {
              workflowId,
              // To test attaching multiple callers to the same operation.
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
        `http://localhost:${httpPort}/nexus/endpoints/${endpointId}/services/testService/testOp`
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
