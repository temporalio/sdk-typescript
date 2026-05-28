import assert from 'assert';
import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import { NexusOperationFailure } from '@temporalio/common';
import {
  NexusOperationExecutionStatus,
  WorkflowExecutionAlreadyStartedError,
  WorkflowFailedError,
} from '@temporalio/client';
import * as temporalnexus from '@temporalio/nexus';
import { asyncLocalStorage } from '@temporalio/nexus/lib/context';
import { base64URLEncodeNoPadding } from '@temporalio/nexus/lib/token';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';
import { innermostHandlerError } from './helpers-nexus';
import { waitUntil } from './helpers';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowEnvironmentOpts: {
    server: {
      extraArgs: [
        '--dynamic-config-value',
        'nexusoperation.enableStandalone=true',
        '--dynamic-config-value',
        'system.refreshNexusEndpointsMinWait="0s"',
        '--dynamic-config-value',
        'history.enableChasmCallbacks=true',
      ],
    },
  },
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Service definitions

const temporalOpService = nexus.service('temporalOperationService', {
  asyncOp: nexus.operation<string, string>(),
  syncOp: nexus.operation<string, string>(),
  doubleStartOp: nexus.operation<string, void>(),
  retryAfterFailedStartOp: nexus.operation<string, string>(),
});

const temporalCancelOpService = nexus.service('temporalCancelOperationService', {
  blockingOp: nexus.operation<string, void>(),
});

type TemporalOpServiceHandlers = nexus.ServiceHandlerFor<typeof temporalOpService.operations>;
type TemporalCancelOpServiceHandlers = nexus.ServiceHandlerFor<typeof temporalCancelOpService.operations>;

function unusedTemporalOperationHandler<I, O>(): nexus.OperationHandler<I, O> {
  return new temporalnexus.TemporalOperationHandler<I, O>({
    async start() {
      throw new nexus.HandlerError('NOT_IMPLEMENTED', 'not used by this test');
    },
  });
}

function makeTemporalOpServiceHandler(overrides: Partial<TemporalOpServiceHandlers>) {
  const handlers: TemporalOpServiceHandlers = {
    asyncOp: unusedTemporalOperationHandler(),
    syncOp: unusedTemporalOperationHandler(),
    doubleStartOp: unusedTemporalOperationHandler(),
    retryAfterFailedStartOp: unusedTemporalOperationHandler(),
    ...overrides,
  };
  return nexus.serviceHandler(temporalOpService, handlers);
}

function makeTemporalCancelOpServiceHandler(handlers: TemporalCancelOpServiceHandlers) {
  return nexus.serviceHandler(temporalCancelOpService, handlers);
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Caller workflows

export async function temporalAsyncOpCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: temporalOpService });
  return await client.executeOperation('asyncOp', 'hello');
}

export async function temporalSyncOpCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: temporalOpService });
  return await client.executeOperation('syncOp', 'hello');
}

export async function temporalDoubleStartOpCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusServiceClient({ endpoint, service: temporalOpService });
  return await client.executeOperation('doubleStartOp', 'hello');
}

export async function temporalRetryAfterFailedStartOpCaller(endpoint: string, workflowId: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: temporalOpService });
  return await client.executeOperation('retryAfterFailedStartOp', workflowId);
}

export async function temporalDefaultCancelWorkflowCaller(endpoint: string, targetWorkflowId: string): Promise<void> {
  const client = workflow.createNexusServiceClient({ endpoint, service: temporalCancelOpService });
  await client.executeOperation('blockingOp', targetWorkflowId, {
    cancellationType: 'WAIT_CANCELLATION_COMPLETED',
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Target workflows

export async function echoWorkflow(input: string): Promise<string> {
  return input;
}

export async function blockingTargetWorkflow(): Promise<void> {
  await workflow.condition(() => false);
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Tests

test('TemporalOperationHandler infers correct output type from typed workflow function', async (t) => {
  const _stringOp: nexus.OperationHandler<string, string> = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, client, input: string) {
      return await client.startWorkflow(echoWorkflow, {
        args: [input],
        workflowId: 'test',
      });
    },
  });

  // @ts-expect-error - Output type should be string, not number
  const _mismatchedOp: nexus.OperationHandler<string, number> = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, client, input: string) {
      return await client.startWorkflow(echoWorkflow, {
        args: [input],
        workflowId: 'test',
      });
    },
  });

  const _syncOp: nexus.OperationHandler<string, string> = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, _client, input: string) {
      return temporalnexus.TemporalOperationResult.sync(input);
    },
  });

  const _explicitStringOp: nexus.OperationHandler<string, string> = new temporalnexus.TemporalOperationHandler<
    string,
    string
  >({
    async start(_ctx, client, input) {
      return await client.startWorkflow(echoWorkflow, {
        args: [input],
        workflowId: 'test',
      });
    },
  });

  // This test only checks for compile-time errors.
  t.pass();
});

test('TemporalOperationHandler cancel delegates to provided cancelWorkflowRun handler', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const workflowId = randomUUID();

  let customCancelCalled = false;

  const worker = await createWorker({
    nexusServices: [
      makeTemporalCancelOpServiceHandler({
        blockingOp: new temporalnexus.TemporalOperationHandler({
          async start(_ctx, client, workflowId) {
            return await client.startWorkflow(blockingTargetWorkflow, {
              workflowId,
            });
          },
          async cancelWorkflowRun(_ctx, { workflowId }) {
            const handle = temporalnexus.getClient().workflow.getHandle(workflowId);
            await handle.cancel();
            customCancelCalled = true;
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const serviceClient = t.context.env.client.nexus.createServiceClient({
      endpoint: endpointName,
      service: temporalCancelOpService,
    });
    const operation = await serviceClient.startOperation(temporalCancelOpService.operations.blockingOp, workflowId, {
      id: 'op-' + randomUUID(),
      scheduleToCloseTimeout: '60s',
    });
    const workflowHandle = t.context.env.client.workflow.getHandle(workflowId);

    await waitUntil(async () => {
      try {
        return (await workflowHandle.describe()).status.name === 'RUNNING';
      } catch {
        return false;
      }
    }, 4000);

    await operation.cancel('test cancellation');

    await waitUntil(async () => (await operation.describe()).status === NexusOperationExecutionStatus.CANCELED, 4000);
    await waitUntil(async () => (await workflowHandle.describe()).status.name === 'CANCELLED', 4000);

    t.true(customCancelCalled);
  });
});

test('TemporalOperationHandler.cancel rejects invalid operation token type before invoking cancellation hooks', async (t) => {
  const handler = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, _client, _input) {
      return temporalnexus.TemporalOperationResult.sync(undefined);
    },

    async cancelWorkflowRun(_ctx, _options) {
      throw new Error('cancelWorkflowRun should not be called');
    },
  });
  const token = base64URLEncodeNoPadding(JSON.stringify({ t: 2, ns: 'test-namespace' }));

  const err = await asyncLocalStorage.run(
    {
      client: undefined as any,
      endpoint: 'test-endpoint',
      namespace: 'test-namespace',
      taskQueue: 'test-task-queue',
      log: undefined as any,
      metrics: undefined as any,
    },
    async () => {
      return await t.throwsAsync(
        handler.cancel(
          {
            abortSignal: new AbortController().signal,
            headers: {},
            operation: 'operation',
            service: 'service',
          },
          token
        )
      );
    }
  );

  t.regex(err?.message ?? '', /invalid operation token/);
});

test('TemporalOperationHandler async and sync happy paths - caller workflow', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      makeTemporalOpServiceHandler({
        asyncOp: new temporalnexus.TemporalOperationHandler<string, string>({
          async start(_ctx, client, input) {
            return await client.startWorkflow(echoWorkflow, {
              workflowId: randomUUID(),
              args: [input],
            });
          },
        }),
        syncOp: new temporalnexus.TemporalOperationHandler<string, string>({
          async start(_ctx, _client, input) {
            return temporalnexus.TemporalOperationResult.sync(input);
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    let result = await executeWorkflow(temporalAsyncOpCaller, {
      args: [endpointName],
    });
    t.is(result, 'hello');

    result = await executeWorkflow(temporalSyncOpCaller, {
      args: [endpointName],
    });
    t.is(result, 'hello');
  });
});

test('TemporalOperationHandler rejects multiple async starts', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      makeTemporalOpServiceHandler({
        doubleStartOp: new temporalnexus.TemporalOperationHandler<string, void>({
          async start(_ctx, client, input) {
            await client.startWorkflow(echoWorkflow, {
              workflowId: randomUUID(),
              args: [input],
            });
            await client.startWorkflow(echoWorkflow, {
              workflowId: randomUUID(),
              args: [input],
            });
            throw new nexus.HandlerError('INTERNAL', 'expected previous error to be thrown');
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const err = await t.throwsAsync(
      () =>
        executeWorkflow(temporalDoubleStartOpCaller, {
          args: [endpointName],
        }),
      {
        instanceOf: WorkflowFailedError,
      }
    );
    assert(err?.cause instanceof NexusOperationFailure);
    assert(err.cause.cause instanceof nexus.HandlerError);
    const inner = innermostHandlerError(err.cause.cause);
    t.is(inner.type, 'BAD_REQUEST');
    t.regex(inner.message, /Only one async operation can be started per operation handler invocation/);
  });
});

test('TemporalOperationHandler allows retry after failed async start', async (t) => {
  const { createWorker, executeWorkflow, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const conflictWorkflowId = randomUUID();

  const worker = await createWorker({
    nexusServices: [
      makeTemporalOpServiceHandler({
        retryAfterFailedStartOp: new temporalnexus.TemporalOperationHandler<string, string>({
          async start(_ctx, client, workflowId) {
            try {
              await client.startWorkflow(blockingTargetWorkflow, {
                workflowId,
                workflowIdConflictPolicy: 'FAIL',
              });
            } catch (err) {
              if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
                throw err;
              }
              return await client.startWorkflow(echoWorkflow, {
                workflowId: randomUUID(),
                args: [workflowId],
              });
            }
            throw new nexus.HandlerError('INTERNAL', 'Expected first workflow start to fail', {
              retryableOverride: false,
            });
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const conflictHandle = await startWorkflow(blockingTargetWorkflow, {
      workflowId: conflictWorkflowId,
    });
    try {
      const result = await executeWorkflow(temporalRetryAfterFailedStartOpCaller, {
        args: [endpointName, conflictWorkflowId],
      });
      t.is(result, conflictWorkflowId);
    } finally {
      await conflictHandle.cancel();
    }
  });
});

test('TemporalOperationHandler default cancelWorkflowRun cancels backing workflow', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const targetWorkflowId = randomUUID();

  const worker = await createWorker({
    nexusServices: [
      makeTemporalCancelOpServiceHandler({
        blockingOp: new temporalnexus.TemporalOperationHandler<string, void>({
          async start(_ctx, client, workflowId) {
            return await client.startWorkflow(blockingTargetWorkflow, {
              workflowId,
            });
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(temporalDefaultCancelWorkflowCaller, {
      args: [endpointName, targetWorkflowId],
    });

    await waitUntil(
      async () => !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationStartedEventAttributes),
      4000
    );

    const targetHandle = t.context.env.client.workflow.getHandle(targetWorkflowId);
    t.is((await targetHandle.describe()).status.name, 'RUNNING');

    await callerHandle.cancel();

    await waitUntil(async () => (await callerHandle.describe()).status.name === 'CANCELLED', 4000);
    await waitUntil(async () => (await targetHandle.describe()).status.name === 'CANCELLED', 4000);
  });
});
