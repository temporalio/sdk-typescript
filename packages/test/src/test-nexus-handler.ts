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
import { ServiceError } from '@temporalio/client';
import { status as grpcStatus } from '@grpc/grpc-js';
import { coerceToHandlerError, operationErrorToProto } from '@temporalio/worker/lib/nexus/conversions';
import { defaultDataConverter } from '@temporalio/common';
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

////////////////////////////////////////////////////////////////////////////////////////////////////
// coerceToHandlerError unit tests

function makeGrpcServiceError(code: number): ServiceError {
  const grpcError = Object.assign(new Error(`gRPC error ${code}`), {
    code,
    details: 'test details',
    metadata: {},
  });
  return new ServiceError(`ServiceError wrapping gRPC ${code}`, { cause: grpcError });
}

test('coerceToHandlerError maps gRPC status codes to expected HandlerError types', (t) => {
  const cases: { code: number; name: string; expectedType: nexus.HandlerErrorType; expectedRetryableOverride?: boolean }[] = [
    // Single-code cases
    { code: grpcStatus.INVALID_ARGUMENT, name: 'INVALID_ARGUMENT', expectedType: 'BAD_REQUEST' },
    { code: grpcStatus.NOT_FOUND, name: 'NOT_FOUND', expectedType: 'NOT_FOUND' },
    { code: grpcStatus.RESOURCE_EXHAUSTED, name: 'RESOURCE_EXHAUSTED', expectedType: 'RESOURCE_EXHAUSTED' },
    { code: grpcStatus.UNIMPLEMENTED, name: 'UNIMPLEMENTED', expectedType: 'NOT_IMPLEMENTED' },
    { code: grpcStatus.DEADLINE_EXCEEDED, name: 'DEADLINE_EXCEEDED', expectedType: 'UPSTREAM_TIMEOUT' },
    // Multi-code cases: non-retryable INTERNAL
    { code: grpcStatus.ALREADY_EXISTS, name: 'ALREADY_EXISTS', expectedType: 'INTERNAL', expectedRetryableOverride: false },
    { code: grpcStatus.FAILED_PRECONDITION, name: 'FAILED_PRECONDITION', expectedType: 'INTERNAL', expectedRetryableOverride: false },
    { code: grpcStatus.OUT_OF_RANGE, name: 'OUT_OF_RANGE', expectedType: 'INTERNAL', expectedRetryableOverride: false },
    // Multi-code cases: UNAVAILABLE
    { code: grpcStatus.ABORTED, name: 'ABORTED', expectedType: 'UNAVAILABLE' },
    { code: grpcStatus.UNAVAILABLE, name: 'UNAVAILABLE', expectedType: 'UNAVAILABLE' },
    // Multi-code cases: retryable INTERNAL
    { code: grpcStatus.CANCELLED, name: 'CANCELLED', expectedType: 'INTERNAL' },
    { code: grpcStatus.DATA_LOSS, name: 'DATA_LOSS', expectedType: 'INTERNAL' },
    { code: grpcStatus.INTERNAL, name: 'INTERNAL', expectedType: 'INTERNAL' },
    { code: grpcStatus.UNKNOWN, name: 'UNKNOWN', expectedType: 'INTERNAL' },
    { code: grpcStatus.UNAUTHENTICATED, name: 'UNAUTHENTICATED', expectedType: 'INTERNAL' },
    { code: grpcStatus.PERMISSION_DENIED, name: 'PERMISSION_DENIED', expectedType: 'INTERNAL' },
  ];

  for (const { code, name, expectedType, expectedRetryableOverride } of cases) {
    const result = coerceToHandlerError(makeGrpcServiceError(code));
    t.is(result.type, expectedType, `${name}: expected type ${expectedType}, got ${result.type}`);
    if (expectedRetryableOverride !== undefined) {
      t.is(result.retryableOverride, expectedRetryableOverride, `${name}: expected retryableOverride ${expectedRetryableOverride}`);
    }
  }
});

test('coerceToHandlerError passes through HandlerError unchanged', (t) => {
  const original = new nexus.HandlerError('BAD_REQUEST', 'test');
  t.is(coerceToHandlerError(original), original);
});

test('coerceToHandlerError maps non-retryable ApplicationFailure to INTERNAL', (t) => {
  const result = coerceToHandlerError(ApplicationFailure.create({ nonRetryable: true, message: 'fail' }));
  t.is(result.type, 'INTERNAL');
  t.is(result.retryableOverride, false);
});

test('coerceToHandlerError maps unknown errors to INTERNAL', (t) => {
  t.is(coerceToHandlerError(new Error('something')).type, 'INTERNAL');
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// operationErrorToProto unit tests

test('operationErrorToProto - failed state produces ApplicationFailure with cause chain', async (t) => {
  const cause = ApplicationFailure.create({ message: 'root cause', type: 'RootError', nonRetryable: true, details: ['detail1'] });
  const opErr = new nexus.OperationError('failed', 'operation failed', { cause });

  const failure = await operationErrorToProto(defaultDataConverter, opErr);

  // Top-level should be an ApplicationFailure with type 'OperationError'
  t.truthy(failure.applicationFailureInfo);
  t.is(failure.applicationFailureInfo?.type, 'OperationError');
  t.is(failure.applicationFailureInfo?.nonRetryable, true);
  t.is(failure.message, 'operation failed');

  // Cause chain should preserve the original ApplicationFailure
  t.truthy(failure.cause);
  t.truthy(failure.cause?.applicationFailureInfo);
  t.is(failure.cause?.message, 'root cause');
  t.is(failure.cause?.applicationFailureInfo?.type, 'RootError');
  t.is(failure.cause?.applicationFailureInfo?.nonRetryable, true);
});

test('operationErrorToProto - canceled state produces CancelledFailure with cause chain', async (t) => {
  const cause = new CancelledFailure('inner cancel');
  const opErr = new nexus.OperationError('canceled', 'operation canceled', { cause });

  const failure = await operationErrorToProto(defaultDataConverter, opErr);

  t.truthy(failure.canceledFailureInfo);
  t.is(failure.message, 'operation canceled');

  // Cause chain should preserve the CancelledFailure
  t.truthy(failure.cause);
  t.truthy(failure.cause?.canceledFailureInfo);
  t.is(failure.cause?.message, 'inner cancel');
});

test('operationErrorToProto - failed state without cause produces standalone ApplicationFailure', async (t) => {
  const opErr = new nexus.OperationError('failed', 'no cause');

  const failure = await operationErrorToProto(defaultDataConverter, opErr);

  t.truthy(failure.applicationFailureInfo);
  t.is(failure.applicationFailureInfo?.type, 'OperationError');
  t.is(failure.message, 'no cause');
  t.falsy(failure.cause);
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
