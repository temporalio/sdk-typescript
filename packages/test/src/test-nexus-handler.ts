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
  ProtoFailure,
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

test('HandlerError round-trips losslessly through failure converter via originalFailure', (t) => {
  const RetryBehavior = root.temporal.api.enums.v1.NexusHandlerErrorRetryBehavior;
  const cases: { name: string; failure: ProtoFailure }[] = [
    {
      name: 'simple HandlerError, no cause, NON_RETRYABLE',
      failure: {
        message: 'handler failed',
        stackTrace: 'at handler (foo.ts:1:1)',
        source: 'TypeScriptSDK',
        nexusHandlerFailureInfo: {
          type: 'INTERNAL',
          retryBehavior: RetryBehavior.NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_NON_RETRYABLE,
        },
      },
    },
    {
      name: 'HandlerError with ApplicationFailure cause',
      failure: {
        message: 'handler failed',
        stackTrace: 'at handler (foo.ts:1:1)',
        source: 'TypeScriptSDK',
        nexusHandlerFailureInfo: {
          type: 'NOT_FOUND',
          retryBehavior: RetryBehavior.NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_RETRYABLE,
        },
        cause: {
          message: 'app error',
          stackTrace: 'at doWork (bar.ts:2:2)',
          source: 'TypeScriptSDK',
          applicationFailureInfo: {
            type: 'MyError',
            nonRetryable: true,
          },
        },
      },
    },
    {
      name: 'HandlerError with nested cause chain',
      failure: {
        message: 'handler failed',
        stackTrace: '',
        source: 'TypeScriptSDK',
        nexusHandlerFailureInfo: {
          type: 'INTERNAL',
          retryBehavior: RetryBehavior.NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_NON_RETRYABLE,
        },
        cause: {
          message: 'app error',
          stackTrace: '',
          source: 'TypeScriptSDK',
          applicationFailureInfo: {
            type: 'Wrapper',
            nonRetryable: false,
          },
          cause: {
            message: 'cancelled',
            stackTrace: '',
            source: 'TypeScriptSDK',
            canceledFailureInfo: {},
          },
        },
      },
    },
    {
      name: 'HandlerError with unspecified retry behavior',
      failure: {
        message: 'unknown error',
        stackTrace: '',
        source: 'TypeScriptSDK',
        nexusHandlerFailureInfo: {
          type: 'UNAVAILABLE',
          retryBehavior: RetryBehavior.NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_UNSPECIFIED,
        },
      },
    },
  ];

  for (const { name, failure } of cases) {
    const error = defaultFailureConverter.failureToError(failure, defaultPayloadConverter);
    t.true(error instanceof nexus.HandlerError, `${name}: should produce HandlerError`);
    const roundTripped = defaultFailureConverter.errorToFailure(error, defaultPayloadConverter);
    t.deepEqual(roundTripped, failure, `${name}: round-tripped ProtoFailure should equal original`);
  }
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
