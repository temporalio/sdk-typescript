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
import {
  base64URLEncodeNoPadding,
  encodeOperationToken,
  generateWorkflowRunOperationToken,
  OperationTokenType,
} from '@temporalio/nexus/lib/token';
import * as workflow from '@temporalio/workflow';
import { Context } from '@temporalio/activity';
import { helpers, makeTestFunction } from './helpers-integration';
import { innermostHandlerError } from './helpers-nexus';
import { waitUntil } from './helpers';
import { echo, throwAnError } from './activities';

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
  echoActivity: nexus.operation<string, string>(),
  blockingActivity: nexus.operation<string, void>(),
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
    echoActivity: unusedTemporalOperationHandler(),
    blockingActivity: unusedTemporalOperationHandler(),
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
// Activities

const activities = {
  echo,
  throwAnError,
  async waitForCancellation() {
    const cx = Context.current();
    while (true) {
      await cx.sleep(300);
      await cx.heartbeat();
    }
  },
};

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
  const token = base64URLEncodeNoPadding(JSON.stringify({ t: 99, ns: 'test-namespace' }));

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

test('TemporalOperationHandler.cancel rejects malformed activity token before invoking cancelActivity', async (t) => {
  let cancelActivityCalled = false;
  const handler = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, _client, _input) {
      return temporalnexus.TemporalOperationResult.sync(undefined);
    },

    async cancelActivity(_ctx, _options) {
      cancelActivityCalled = true;
      throw new Error('cancelActivity should not be called');
    },
  });
  const token = base64URLEncodeNoPadding(JSON.stringify({ t: OperationTokenType.ACTIVITY, ns: 'test-namespace' }));

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

  assert(err instanceof nexus.HandlerError);
  t.is(err.type, 'BAD_REQUEST');
  t.regex(err.message, /invalid activity operation token/);
  t.false(cancelActivityCalled, 'cancelActivity must not be invoked for a malformed activity token');
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

// A single backing-operation start, as invoked from inside a start handler. The result is
// awaited then discarded because the parameterized guard test always throws afterwards.
type StartAction = (client: temporalnexus.TemporalNexusClient, input: string) => Promise<unknown>;

const startWorkflowAction: StartAction = (client, input) =>
  client.startWorkflow(echoWorkflow, {
    workflowId: randomUUID(),
    args: [input],
  });

const startActivityAction: StartAction = (client, input) =>
  client.startActivity('echo', {
    id: randomUUID(),
    args: [input],
    scheduleToCloseTimeout: '10s',
  });

// The shared multiple-async-start guard (withAsyncOperationStartReservation) must reject a
// second backing-operation start regardless of which start kinds are combined. Each case's
// `name` becomes part of the test title and the derived Nexus endpoint name, so it must use
// only characters the endpoint-name transform sanitizes (letters/digits/spaces/parens/hyphens);
// avoid '+', '&', etc., which leak through and fail endpoint registration. Add a row to cover a
// new combination, or a new StartAction const to cover a new start kind.
const multipleAsyncStartCases: { name: string; first: StartAction; second: StartAction }[] = [
  { name: 'workflow then workflow', first: startWorkflowAction, second: startWorkflowAction },
  { name: 'activity then activity', first: startActivityAction, second: startActivityAction },
  { name: 'workflow then activity', first: startWorkflowAction, second: startActivityAction },
  { name: 'activity then workflow', first: startActivityAction, second: startWorkflowAction },
];

for (const { name, first, second } of multipleAsyncStartCases) {
  test(`TemporalOperationHandler rejects multiple async starts (${name})`, async (t) => {
    const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
    const { endpointName } = await registerNexusEndpoint();

    const worker = await createWorker({
      activities,
      nexusServices: [
        makeTemporalOpServiceHandler({
          doubleStartOp: new temporalnexus.TemporalOperationHandler<string, void>({
            async start(_ctx, client, input) {
              await first(client, input);
              await second(client, input); // guard trips here
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
}

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

test('TemporalOperationHandler workflow run has Nexus-Operation-Token Header', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      makeTemporalOpServiceHandler({
        asyncOp: new temporalnexus.TemporalOperationHandler<string, string>({
          async start(_ctx, client, input) {
            return await client.startWorkflow(echoWorkflow, {
              workflowId: input,
              args: [input],
            });
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const targetWorkflowId = randomUUID();
    const nexusClient = client.nexus.createServiceClient({ endpoint: endpointName, service: temporalOpService });

    const result = await nexusClient.executeOperation(temporalOpService.operations.asyncOp, targetWorkflowId, {
      id: randomUUID(),
      scheduleToCloseTimeout: '10s',
    });
    t.is(result, targetWorkflowId);

    const targetHandle = client.workflow.getHandle(targetWorkflowId);
    const desc = await targetHandle.describe();

    const opToken = desc.raw.callbacks?.[0].callback?.nexus?.header?.['nexus-operation-token'];
    t.is(opToken, generateWorkflowRunOperationToken(client.options.namespace, targetHandle.workflowId));
  });
});

test('TemporalOperationHandler activity has Nexus-Operation-Token Header', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    activities,
    nexusServices: [
      makeTemporalOpServiceHandler({
        asyncOp: new temporalnexus.TemporalOperationHandler<string, string>({
          async start(_ctx, client, input) {
            return await client.typedActivity<typeof activities>().startActivity('echo', {
              id: input,
              args: [input],
              scheduleToCloseTimeout: '10s',
            });
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const targetActivityId = randomUUID();
    const nexusClient = client.nexus.createServiceClient({ endpoint: endpointName, service: temporalOpService });

    const result = await nexusClient.executeOperation(temporalOpService.operations.asyncOp, targetActivityId, {
      id: randomUUID(),
      scheduleToCloseTimeout: '10s',
    });
    t.is(result, targetActivityId);

    const targetHandle = client.activity.getHandle(targetActivityId);
    const desc = await targetHandle.describe();

    const expectedToken = encodeOperationToken({
      t: OperationTokenType.ACTIVITY,
      ns: client.options.namespace,
      aid: targetActivityId,
    });
    const actualToken = desc.rawCallbacks?.[0].info?.callback?.nexus?.header?.['nexus-operation-token'];
    t.is(actualToken, expectedToken);
  });
});

test('TemporalOperationHandler start typed standalone activity', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { client } = t.context.env;

  const worker = await createWorker({
    activities,
    nexusServices: [
      makeTemporalOpServiceHandler({
        echoActivity: new temporalnexus.TemporalOperationHandler({
          async start(_ctx, client, input) {
            return await client.typedActivity<typeof activities>().startActivity('echo', {
              id: randomUUID(),
              args: [input],
              scheduleToCloseTimeout: '10s',
            });
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const nexusSvc = client.nexus.createServiceClient({ endpoint: endpointName, service: temporalOpService });
    const result = await nexusSvc.executeOperation(temporalOpService.operations.echoActivity, 'foo', {
      id: randomUUID(),
    });
    t.is(result, 'foo');
  });
});

test('TemporalOperationHandler start untyped standalone activity', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { client } = t.context.env;

  const worker = await createWorker({
    activities,
    nexusServices: [
      makeTemporalOpServiceHandler({
        echoActivity: new temporalnexus.TemporalOperationHandler({
          async start(_ctx, client, input) {
            return await client.startActivity('echo', {
              id: randomUUID(),
              args: [input],
              scheduleToCloseTimeout: '10s',
            });
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const nexusSvc = client.nexus.createServiceClient({ endpoint: endpointName, service: temporalOpService });
    const result = await nexusSvc.executeOperation(temporalOpService.operations.echoActivity, 'foo', {
      id: randomUUID(),
    });
    t.is(result, 'foo');
  });
});

test('TemporalOperationHandler cancels backing activity', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { client } = t.context.env;

  let startedActivity = false;

  const worker = await createWorker({
    activities,
    nexusServices: [
      makeTemporalOpServiceHandler({
        blockingActivity: new temporalnexus.TemporalOperationHandler({
          async start(_ctx, client, input) {
            const result = await client.typedActivity<typeof activities>().startActivity('waitForCancellation', {
              id: input,
              scheduleToCloseTimeout: '10s',
            });
            startedActivity = true;
            return result;
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const nexusSvc = client.nexus.createServiceClient({ endpoint: endpointName, service: temporalOpService });
    const targetActivityId = `wait-for-cancel-${randomUUID()}`;
    const handle = await nexusSvc.startOperation(temporalOpService.operations.blockingActivity, targetActivityId, {
      id: randomUUID(),
    });
    await waitUntil(async () => startedActivity, 4000);

    const activityHandle = client.activity.getHandle(targetActivityId);

    await handle.cancel();

    await waitUntil(async () => (await handle.describe()).status === 'CANCELED', 4000);
    await waitUntil(async () => (await activityHandle.describe()).status === 'CANCELED', 4000);

    // Assertions built into the waitUntils
    t.pass();
  });
});

test('TemporalOperationHandler invokes custom cancelActivity', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { client } = t.context.env;

  let activityStarted = false;
  let customCancelCalled = false;

  const worker = await createWorker({
    activities,
    nexusServices: [
      makeTemporalOpServiceHandler({
        blockingActivity: new temporalnexus.TemporalOperationHandler({
          async start(_ctx, client, input) {
            const result = await client.typedActivity<typeof activities>().startActivity('waitForCancellation', {
              id: input,
              scheduleToCloseTimeout: '10s',
            });
            activityStarted = true;
            return result;
          },
          async cancelActivity(ctx, { activityId, runId }) {
            console.log('activityId', activityId);
            console.log('runId', runId);
            const handle = temporalnexus.getClient().activity.getHandle(activityId, runId);
            await handle.cancel('test custom cancellation');
            customCancelCalled = true;
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const nexusSvc = client.nexus.createServiceClient({ endpoint: endpointName, service: temporalOpService });
    const targetActivityId = `wait-for-cancel-${randomUUID()}`;
    const result = await nexusSvc.startOperation(temporalOpService.operations.blockingActivity, targetActivityId, {
      id: randomUUID(),
    });

    await waitUntil(async () => activityStarted, 4000);

    const activityHandle = client.activity.getHandle(targetActivityId);
    await result.cancel();

    await waitUntil(async () => (await result.describe()).status === 'CANCELED', 4000);
    await waitUntil(async () => (await activityHandle.describe()).status === 'CANCELED', 4000);
    t.true(customCancelCalled, 'expected custom cancel to be called');
  });
});
