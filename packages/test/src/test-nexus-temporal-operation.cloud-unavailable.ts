import assert from 'assert';
import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import { ApplicationFailure, CancelledFailure, NexusOperationFailure } from '@temporalio/common';
import {
  ActivityExecutionFailedError,
  NexusOperationExecutionStatus,
  NexusOperationFailureError,
  WorkflowExecutionAlreadyStartedError,
  WorkflowFailedError,
} from '@temporalio/client';
import * as temporalnexus from '@temporalio/nexus';
import { temporal } from '@temporalio/proto';
import {
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

const { EventType } = temporal.api.enums.v1;

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
        '--dynamic-config-value',
        'activity.enableCallbacks=true',
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
  failingActivity: nexus.operation<string, void>(),
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
    failingActivity: unusedTemporalOperationHandler(),
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

export async function temporalActivityOpCaller(endpoint: string, activityId: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: temporalOpService });
  return await client.executeOperation('echoActivity', activityId);
}

export async function temporalSyncOpCallerWithInput(endpoint: string, input: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: temporalOpService });
  return await client.executeOperation('syncOp', input);
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

function createDeferred(): [promise: Promise<void>, resolve: () => void] {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return [promise, resolve];
}

// Activity cancellation is delivered through heartbeats. Without a heartbeat timeout, the default heartbeat throttle
// is 30 seconds, which can let the activity's terminal timeout win the race with cancellation in these tests.
const cancellationHeartbeatInterval = '100ms';

function createCancellationActivities(markActivityStarted: () => void) {
  return {
    ...activities,
    async waitForCancellation() {
      const cx = Context.current();
      cx.heartbeat();
      markActivityStarted();
      while (true) {
        await cx.sleep(cancellationHeartbeatInterval);
        cx.heartbeat();
      }
    },
  };
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Tests

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

const startWorkflowAction: StartAction = (client) =>
  client.startWorkflow(blockingTargetWorkflow, {
    workflowId: randomUUID(),
    workflowExecutionTimeout: '30s',
  });

const startActivityAction: StartAction = (client) =>
  client.startActivity('waitForCancellation', {
    id: randomUUID(),
    scheduleToCloseTimeout: '30s',
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

test('TemporalOperationHandler links a Workflow-invoked Nexus operation and its backing activity', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    activities,
    nexusServices: [
      makeTemporalOpServiceHandler({
        echoActivity: new temporalnexus.TemporalOperationHandler<string, string>({
          async start(_ctx, nexusClient, activityId) {
            return await nexusClient.typedActivity<typeof activities>().startActivity('echo', {
              id: activityId,
              args: [activityId],
              scheduleToCloseTimeout: '10s',
            });
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const targetActivityId = randomUUID();
    const callerHandle = await startWorkflow(temporalActivityOpCaller, {
      args: [endpointName, targetActivityId],
    });
    t.is(await callerHandle.result(), targetActivityId);

    const callerHistory = await callerHandle.fetchHistory();
    const startedEvent = callerHistory.events?.find((event) => event.nexusOperationStartedEventAttributes != null);
    const activityLink = startedEvent?.links?.find((link) => link.activity != null)?.activity;
    const targetActivity = await client.activity.getHandle(targetActivityId).describe();

    t.is(activityLink?.namespace, client.options.namespace);
    t.is(activityLink?.activityId, targetActivityId);
    t.is(activityLink?.runId, targetActivity.activityRunId);

    const callerLink = targetActivity.rawCallbacks
      ?.flatMap((callbackInfo) => callbackInfo.info?.callback?.links ?? [])
      .find((link) => link.workflowEvent?.workflowId === callerHandle.workflowId)?.workflowEvent;
    t.truthy(callerLink, 'expected Activity completion callback to link to the caller Nexus operation');
    t.is(callerLink?.namespace, client.options.namespace);
    t.is(callerLink?.workflowId, callerHandle.workflowId);
    t.is(callerLink?.eventRef?.eventType, EventType.EVENT_TYPE_NEXUS_OPERATION_SCHEDULED);
  });
});

test('TemporalOperationHandler links a standalone Nexus operation and its backing activity', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    activities,
    nexusServices: [
      makeTemporalOpServiceHandler({
        echoActivity: new temporalnexus.TemporalOperationHandler<string, string>({
          async start(_ctx, nexusClient, activityId) {
            return await nexusClient.typedActivity<typeof activities>().startActivity('echo', {
              id: activityId,
              args: [activityId],
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
    const operation = await nexusClient.startOperation(temporalOpService.operations.echoActivity, targetActivityId, {
      id: randomUUID(),
      scheduleToCloseTimeout: '10s',
    });
    t.is(await operation.result(), targetActivityId);

    const [operationDescription, targetActivity] = await Promise.all([
      operation.describe(),
      client.activity.getHandle(targetActivityId).describe(),
    ]);
    const activityLink = operationDescription.raw.links?.find((link) => link.activity != null)?.activity;

    t.is(activityLink?.namespace, client.options.namespace);
    t.is(activityLink?.activityId, targetActivityId);
    t.is(activityLink?.runId, targetActivity.activityRunId);

    const nexusOperationLink = targetActivity.rawCallbacks
      ?.flatMap((callbackInfo) => callbackInfo.info?.callback?.links ?? [])
      .find((link) => link.nexusOperation?.operationId === operationDescription.operationId)?.nexusOperation;
    t.truthy(nexusOperationLink, 'expected Activity completion callback to link to the standalone Nexus operation');
    t.is(nexusOperationLink?.namespace, client.options.namespace);
    t.is(nexusOperationLink?.operationId, operationDescription.operationId);
    t.is(nexusOperationLink?.runId, operationDescription.runId);
  });
});

test('TemporalOperationHandler links Activities started through a raw ActivityClient - standalone caller', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    activities,
    nexusServices: [
      makeTemporalOpServiceHandler({
        syncOp: new temporalnexus.TemporalOperationHandler<string, string>({
          async start(_ctx, nexusClient, input) {
            const { taskQueue } = temporalnexus.operationInfo();
            const [a, b] = await Promise.all([
              nexusClient.client.activity.start('echo', {
                id: `${input}-a`,
                args: [`${input}-a`],
                taskQueue,
                scheduleToCloseTimeout: '10s',
              }),
              nexusClient.client.activity.start('echo', {
                id: `${input}-b`,
                args: [`${input}-b`],
                taskQueue,
                scheduleToCloseTimeout: '10s',
              }),
            ]);
            const [resultA, resultB] = await Promise.all([a.result(), b.result()]);
            return temporalnexus.TemporalOperationResult.sync(`${resultA}|${resultB}`);
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const input = randomUUID();
    const nexusClient = client.nexus.createServiceClient({ endpoint: endpointName, service: temporalOpService });
    const operation = await nexusClient.startOperation(temporalOpService.operations.syncOp, input, {
      id: randomUUID(),
      scheduleToCloseTimeout: '10s',
    });
    t.is(await operation.result(), `${input}-a|${input}-b`);

    const [operationDescription, activityA, activityB] = await Promise.all([
      operation.describe(),
      client.activity.getHandle(`${input}-a`).describe(),
      client.activity.getHandle(`${input}-b`).describe(),
    ]);

    // Backward: the completed operation's own description links to both Activities, not just one.
    const linkedActivityIds = operationDescription.raw.links
      ?.map((link) => link.activity)
      .filter((link): link is NonNullable<typeof link> => link != null)
      .map((link) => link.activityId);
    t.deepEqual([...(linkedActivityIds ?? [])].sort(), [`${input}-a`, `${input}-b`].sort());

    // Forward: each Activity's own record links back to the caller operation.
    for (const activity of [activityA, activityB]) {
      const nexusOperationLink = activity.rawInfo.links?.find((link) => link.nexusOperation != null)?.nexusOperation;
      t.is(nexusOperationLink?.namespace, client.options.namespace);
      t.is(nexusOperationLink?.operationId, operationDescription.operationId);
      t.is(nexusOperationLink?.runId, operationDescription.runId);
    }
  });
});

test('TemporalOperationHandler links Activities started through a raw ActivityClient - Workflow caller', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { client } = t.context.env;
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    activities,
    nexusServices: [
      makeTemporalOpServiceHandler({
        syncOp: new temporalnexus.TemporalOperationHandler<string, string>({
          async start(_ctx, nexusClient, input) {
            const { taskQueue } = temporalnexus.operationInfo();
            const [a, b] = await Promise.all([
              nexusClient.client.activity.start('echo', {
                id: `${input}-a`,
                args: [`${input}-a`],
                taskQueue,
                scheduleToCloseTimeout: '10s',
              }),
              nexusClient.client.activity.start('echo', {
                id: `${input}-b`,
                args: [`${input}-b`],
                taskQueue,
                scheduleToCloseTimeout: '10s',
              }),
            ]);
            const [resultA, resultB] = await Promise.all([a.result(), b.result()]);
            return temporalnexus.TemporalOperationResult.sync(`${resultA}|${resultB}`);
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const input = randomUUID();
    const callerHandle = await startWorkflow(temporalSyncOpCallerWithInput, { args: [endpointName, input] });
    t.is(await callerHandle.result(), `${input}-a|${input}-b`);

    const callerHistory = await callerHandle.fetchHistory();
    const completedEvent = callerHistory.events?.find((event) => event.nexusOperationCompletedEventAttributes != null);
    const linkedActivityIds = completedEvent?.links
      ?.map((link) => link.activity)
      .filter((link): link is NonNullable<typeof link> => link != null)
      .map((link) => link.activityId);
    t.deepEqual([...(linkedActivityIds ?? [])].sort(), [`${input}-a`, `${input}-b`].sort());

    for (const suffix of ['a', 'b']) {
      const activityId = `${input}-${suffix}`;
      const activity = await client.activity.getHandle(activityId).describe();
      const callerLink = activity.rawInfo.links?.find((link) => link.workflowEvent != null)?.workflowEvent;
      t.truthy(callerLink, `expected Activity ${activityId} to link back to the caller Workflow`);
      t.is(callerLink?.workflowId, callerHandle.workflowId);
      t.is(callerLink?.eventRef?.eventType, EventType.EVENT_TYPE_NEXUS_OPERATION_SCHEDULED);
    }
  });
});

test('TemporalOperationHandler Activity started through a raw ActivityClient is redelivery-safe', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  let activityInvocationCount = 0;
  let hasFailedOnce = false;
  const worker = await createWorker({
    activities: {
      async countedEcho(input: string): Promise<string> {
        activityInvocationCount++;
        return input;
      },
    },
    nexusServices: [
      makeTemporalOpServiceHandler({
        syncOp: new temporalnexus.TemporalOperationHandler<string, string>({
          async start(_ctx, nexusClient, input) {
            const { taskQueue } = temporalnexus.operationInfo();
            // Starts through the raw Activity client, not TemporalNexusClient.startActivity().
            const handle = await nexusClient.client.activity.start('countedEcho', {
              id: input,
              args: [input],
              taskQueue,
              scheduleToCloseTimeout: '10s',
            });
            const result = await handle.result();
            if (!hasFailedOnce) {
              hasFailedOnce = true;
              // Force a Nexus-task redelivery after the Activity has already completed.
              throw new nexus.HandlerError('INTERNAL', 'inject retry', { retryableOverride: true });
            }
            return temporalnexus.TemporalOperationResult.sync(result);
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const input = randomUUID();
    const callerHandle = await startWorkflow(temporalSyncOpCallerWithInput, { args: [endpointName, input] });
    t.is(await callerHandle.result(), input);
    t.is(activityInvocationCount, 1, 'expected the Activity to run exactly once despite the handler redelivery');
  });
});

test('TemporalOperationHandler activity links are not duplicated', async (t) => {
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
    const operation = await nexusClient.startOperation(temporalOpService.operations.asyncOp, targetActivityId, {
      id: randomUUID(),
      scheduleToCloseTimeout: '10s',
    });
    const result = await operation.result();
    t.is(result, targetActivityId);

    const desc = await client.activity.getHandle(targetActivityId).describe();
    const callback = desc.rawCallbacks?.[0].info?.callback;
    const nexusOperationLink = callback?.links?.find((link) => link.nexusOperation != null)?.nexusOperation;
    t.is(nexusOperationLink?.operationId, operation.operationId);
    t.deepEqual(desc.rawInfo.links, []);
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

test('TemporalOperationHandler propagates backing activity failure', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { client } = t.context.env;

  const worker = await createWorker({
    activities,
    nexusServices: [
      makeTemporalOpServiceHandler({
        failingActivity: new temporalnexus.TemporalOperationHandler<string, void>({
          async start(_ctx, client, message) {
            // throwAnError(true, message) throws a non-retryable ApplicationFailure, so the
            // backing activity fails permanently and the failure propagates to the Nexus caller.
            return await client.typedActivity<typeof activities>().startActivity('throwAnError', {
              id: randomUUID(),
              args: [true, message],
              scheduleToCloseTimeout: '10s',
            });
          },
        }),
      }),
    ],
  });

  await worker.runUntil(async () => {
    const nexusSvc = client.nexus.createServiceClient({ endpoint: endpointName, service: temporalOpService });
    const err = await t.throwsAsync(
      nexusSvc.executeOperation(temporalOpService.operations.failingActivity, 'activity failed', {
        id: randomUUID(),
      }),
      { instanceOf: NexusOperationFailureError }
    );

    assert(err?.cause instanceof ApplicationFailure);
    const activityFailure = err.cause.cause;
    assert(activityFailure instanceof ApplicationFailure);
    t.is(activityFailure.message, 'activity failed');
    t.is(activityFailure.type, 'Error');
    t.true(activityFailure.nonRetryable);
  });
});

test.serial('TemporalOperationHandler cancels backing activity', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { client } = t.context.env;

  const [activityStarted, markActivityStarted] = createDeferred();
  const cancellationActivities = createCancellationActivities(markActivityStarted);

  const worker = await createWorker({
    activities: cancellationActivities,
    defaultHeartbeatThrottleInterval: cancellationHeartbeatInterval,
    nexusServices: [
      makeTemporalOpServiceHandler({
        blockingActivity: new temporalnexus.TemporalOperationHandler({
          async start(_ctx, client, input) {
            return await client.typedActivity<typeof cancellationActivities>().startActivity('waitForCancellation', {
              id: input,
              scheduleToCloseTimeout: '30s',
            });
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
    await activityStarted;

    const { activityRunId } = await client.activity.getHandle(targetActivityId).describe();
    const activityHandle = client.activity.getHandle(targetActivityId, activityRunId);

    await handle.cancel();

    const [activityError, operationError] = await Promise.all([
      t.throwsAsync(activityHandle.result(), { instanceOf: ActivityExecutionFailedError }),
      t.throwsAsync(handle.result(), { instanceOf: NexusOperationFailureError }),
    ]);
    t.true(
      activityError?.cause instanceof CancelledFailure,
      `Expected backing activity cancellation, got ${activityError?.cause?.name ?? 'no cause'}`
    );
    t.true(
      operationError?.cause instanceof CancelledFailure,
      `Expected Nexus operation cancellation, got ${operationError?.cause?.name ?? 'no cause'}`
    );

    t.is((await activityHandle.describe()).status, 'CANCELED');
    t.is((await handle.describe()).status, NexusOperationExecutionStatus.CANCELED);
  });
});

test.serial('TemporalOperationHandler invokes custom cancelActivity', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { client } = t.context.env;

  const [activityStarted, markActivityStarted] = createDeferred();
  const [customCancelCalled, markCustomCancelCalled] = createDeferred();
  const cancellationActivities = createCancellationActivities(markActivityStarted);
  let canceledActivityRunId: string | undefined;

  const worker = await createWorker({
    activities: cancellationActivities,
    defaultHeartbeatThrottleInterval: cancellationHeartbeatInterval,
    nexusServices: [
      makeTemporalOpServiceHandler({
        blockingActivity: new temporalnexus.TemporalOperationHandler({
          async start(_ctx, client, input) {
            return await client.typedActivity<typeof cancellationActivities>().startActivity('waitForCancellation', {
              id: input,
              scheduleToCloseTimeout: '30s',
            });
          },
          async cancelActivity(_ctx, { activityId, runId }) {
            canceledActivityRunId = runId;
            const handle = temporalnexus.getClient().activity.getHandle(activityId, runId);
            await handle.cancel('test custom cancellation');
            markCustomCancelCalled();
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

    await activityStarted;

    const { activityRunId } = await client.activity.getHandle(targetActivityId).describe();
    const activityHandle = client.activity.getHandle(targetActivityId, activityRunId);
    await result.cancel();

    await customCancelCalled;
    t.is(canceledActivityRunId, activityRunId);

    const [activityError, operationError] = await Promise.all([
      t.throwsAsync(activityHandle.result(), { instanceOf: ActivityExecutionFailedError }),
      t.throwsAsync(result.result(), { instanceOf: NexusOperationFailureError }),
    ]);
    t.true(
      activityError?.cause instanceof CancelledFailure,
      `Expected backing activity cancellation, got ${activityError?.cause?.name ?? 'no cause'}`
    );
    t.true(
      operationError?.cause instanceof CancelledFailure,
      `Expected Nexus operation cancellation, got ${operationError?.cause?.name ?? 'no cause'}`
    );

    t.is((await activityHandle.describe()).status, 'CANCELED');
    t.is((await result.describe()).status, NexusOperationExecutionStatus.CANCELED);
  });
});
