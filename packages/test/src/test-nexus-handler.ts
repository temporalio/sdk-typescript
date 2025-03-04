import { randomUUID } from 'node:crypto';
import anyTest, { TestFn } from 'ava';
import getPort from 'get-port';
import * as nexus from 'nexus-rpc';
import * as protoJsonSerializer from 'proto3-json-serializer';
import * as temporalnexus from '@temporalio/nexus';
import * as root from '@temporalio/proto';
import * as testing from '@temporalio/testing';
import { DefaultLogger, LogEntry, Runtime, Worker } from '@temporalio/worker';
import { ApplicationFailure, CancelledFailure, defaultFailureConverter, defaultPayloadConverter, SdkComponent } from '@temporalio/common';
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
    server: { extraArgs: ['--http-port', `${t.context.httpPort}`] },
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
      name: t.title.replaceAll(' ', '-'),
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
    at op (test/src/test-nexus-handler.ts)`
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
    at op (test/src/test-nexus-handler.ts)`
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
    at op (test/src/test-nexus-handler.ts)`
      );
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
    at Object.cancel (test/src/test-nexus-handler.ts)`
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
    at Object.cancel (test/src/test-nexus-handler.ts)`
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
