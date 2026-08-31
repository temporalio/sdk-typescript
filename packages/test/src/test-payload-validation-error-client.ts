import test from 'ava';
import * as nexus from 'nexus-rpc';
import type { PayloadConverter } from '@temporalio/common';
import { createPayloadValidationError, defaultFailureConverter, defaultPayloadConverter } from '@temporalio/common';
import { AsyncCompletionClient, Client } from '@temporalio/client';

test('public client payload validation failures return locally without issuing RPCs', async (t) => {
  const failure = createPayloadValidationError({ field: 'invalid' });
  const payloadConverter: PayloadConverter = {
    toPayload(): never {
      throw failure;
    },
    fromPayload(payload, context) {
      return defaultPayloadConverter.fromPayload(payload, context);
    },
  };
  let rpcCount = 0;
  const workflowService = new Proxy(
    {},
    {
      get() {
        return async () => {
          rpcCount++;
          return {};
        };
      },
    }
  );
  const connection = {
    workflowService,
    operatorService: {},
    healthService: {},
    plugins: [],
    withDeadline: (_deadline: unknown, fn: () => unknown) => fn(),
    withAbortSignal: (_signal: unknown, fn: () => unknown) => fn(),
    withMetadata: (_metadata: unknown, fn: () => unknown) => fn(),
  } as any;
  const dataConverter = { payloadConverter, failureConverter: defaultFailureConverter, payloadCodecs: [] } as any;
  const client = new Client({ connection, dataConverter });
  const completionClient = new AsyncCompletionClient({ connection, dataConverter });
  const workflowHandle = client.workflow.getHandle('workflow-id');
  const nexusService = nexus.service('service', { operation: nexus.operation<string, string>() });
  const nexusClient = client.nexus.createServiceClient({ endpoint: 'endpoint', service: nexusService });

  const calls: Array<() => Promise<unknown>> = [
    () => client.workflow.start('workflow', { workflowId: 'workflow-id', taskQueue: 'queue', args: ['bad'] }),
    () =>
      client.activity.start('activity', {
        id: 'activity-id',
        taskQueue: 'queue',
        startToCloseTimeout: '1m',
        args: ['bad'],
      }),
    () => workflowHandle.signal('signal', 'bad'),
    () =>
      client.workflow.signalWithStart('workflow', {
        workflowId: 'workflow-id',
        taskQueue: 'queue',
        args: ['bad'],
        signal: 'signal',
        signalArgs: ['bad'],
      }),
    () => workflowHandle.query('query', 'bad'),
    () => workflowHandle.executeUpdate('update', { args: ['bad'] }),
    () => completionClient.complete(new Uint8Array([1]), 'bad'),
    () => completionClient.fail(new Uint8Array([1]), failure),
    () => completionClient.reportCancellation(new Uint8Array([1]), 'bad'),
    () => completionClient.heartbeat(new Uint8Array([1]), 'bad'),
    () => nexusClient.startOperation('operation', 'bad', { id: 'operation-id' }),
  ];

  for (const call of calls) {
    t.is(await t.throwsAsync(call), failure);
    t.is(rpcCount, 0);
  }
});

test('all public client APIs propagate codec PayloadValidationErrors without RPCs', async (t) => {
  const failure = createPayloadValidationError({ field: 'invalid' });
  let rpcCount = 0;
  const connection = {
    workflowService: new Proxy(
      {},
      {
        get() {
          return async () => {
            rpcCount++;
            return {};
          };
        },
      }
    ),
    operatorService: {},
    healthService: {},
    plugins: [],
    withDeadline: (_deadline: unknown, fn: () => unknown) => fn(),
    withAbortSignal: (_signal: unknown, fn: () => unknown) => fn(),
    withMetadata: (_metadata: unknown, fn: () => unknown) => fn(),
  } as any;
  const dataConverter = {
    payloadCodecs: [
      {
        async encode(): Promise<never> {
          throw failure;
        },
        async decode(payloads: any[]) {
          return payloads;
        },
      },
    ],
  };
  const client = new Client({ connection, dataConverter });
  const completionClient = new AsyncCompletionClient({ connection, dataConverter });
  const workflowHandle = client.workflow.getHandle('workflow-id');
  const nexusService = nexus.service('service', { operation: nexus.operation<string, string>() });
  const nexusClient = client.nexus.createServiceClient({ endpoint: 'endpoint', service: nexusService });

  const calls: Array<() => Promise<unknown>> = [
    () => client.workflow.start('workflow', { workflowId: 'workflow-id', taskQueue: 'queue', args: ['bad'] }),
    () =>
      client.activity.start('activity', {
        id: 'activity-id',
        taskQueue: 'queue',
        startToCloseTimeout: '1m',
        args: ['bad'],
      }),
    () => workflowHandle.signal('signal', 'bad'),
    () =>
      client.workflow.signalWithStart('workflow', {
        workflowId: 'workflow-id',
        taskQueue: 'queue',
        args: ['bad'],
        signal: 'signal',
        signalArgs: ['bad'],
      }),
    () => workflowHandle.query('query', 'bad'),
    () => workflowHandle.executeUpdate('update', { args: ['bad'] }),
    () => completionClient.complete(new Uint8Array([1]), 'bad'),
    () => completionClient.fail(new Uint8Array([1]), failure),
    () => completionClient.reportCancellation(new Uint8Array([1]), 'bad'),
    () => completionClient.heartbeat(new Uint8Array([1]), 'bad'),
    () => nexusClient.startOperation('operation', 'bad', { id: 'operation-id' }),
  ];

  for (const call of calls) {
    t.is(await t.throwsAsync(call), failure);
    t.is(rpcCount, 0);
  }
});
