/**
 * Serialization context coverage for executions started, and Updates sent, by a Nexus operation
 * handler.
 *
 * A Workflow or standalone Activity started by a handler, or an Update it sends, returns its result
 * and failure to the Nexus caller, which decodes them with the operation's
 * {@link NexusSerializationContext}. The handler sends that context with the request, the server
 * propagates it to the Worker, and Clients reading the outcome decode with the context the server
 * returns.
 *
 * Every test runs with {@link nexusContextMarkerCodec}, which marks payloads encoded under the
 * operation's context and rejects a marked payload decoded under any other context.
 */
import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
import * as nexus from 'nexus-rpc';
import * as activity from '@temporalio/activity';
import type { WorkflowClientInterceptor } from '@temporalio/client';
import {
  ActivityExecutionFailedError,
  Client,
  NexusOperationFailureError,
  WorkflowFailedError,
  WorkflowUpdateFailedError,
  WorkflowUpdateStage,
} from '@temporalio/client';
import type { NexusSerializationContext, Payload, PayloadCodec } from '@temporalio/common';
import { ApplicationFailure } from '@temporalio/common';
import * as temporalnexus from '@temporalio/nexus';
import * as wf from '@temporalio/workflow';
import { waitUntil, Worker } from './helpers';
import type { Context } from './helpers-integration';
import { helpers, makeTestFunction } from './helpers-integration';
import { MARKER_KEY, nexusContextMarkerCodec } from './helpers-nexus';
import { nexusCtx } from './payload-converters/serialization-context-converter';

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
        '--dynamic-config-value',
        'history.enableUpdateCallbacks=true',
      ],
    },
  },
});

const MARKER = 'nexus';

////////////////////////////////////////////////////////////////////////////////////////////////////
// Workflow, Activity, and Nexus service

export interface NexusStartedInput {
  id: string;
  value: string;
  outcome: 'result' | 'failure' | 'continueAsNew' | 'async';
}

export async function nexusStartedWorkflow(input: NexusStartedInput): Promise<string> {
  if (input.outcome === 'continueAsNew') {
    await wf.continueAsNew<typeof nexusStartedWorkflow>({ ...input, outcome: 'result' });
  }
  if (input.outcome === 'failure') {
    throw ApplicationFailure.create({
      message: 'nexus-started-failure',
      details: ['failure-detail'],
      nonRetryable: true,
    });
  }
  return input.value;
}

export interface NexusUpdateInput {
  workflowId: string;
  updateId: string;
  value: 'result' | 'failure' | 'rejection';
}

export const nexusUpdate = wf.defineUpdate<string, [string]>('nexusUpdate');
export const finishSignal = wf.defineSignal('finish');

export async function nexusUpdatedWorkflow(): Promise<void> {
  let finished = false;
  wf.setHandler(
    nexusUpdate,
    async (value) => {
      if (value === 'failure') {
        throw ApplicationFailure.create({
          message: 'nexus-update-failure',
          details: ['failure-detail'],
          nonRetryable: true,
        });
      }
      return value;
    },
    {
      validator: (value) => {
        if (value === 'rejection') {
          throw ApplicationFailure.create({ message: 'nexus-update-rejection', details: ['rejection-detail'] });
        }
      },
    }
  );
  wf.setHandler(finishSignal, () => {
    finished = true;
  });
  await wf.condition(() => finished);
}

/** Context each attempt saw in `ActivityInfo.nexusSerializationContext`, keyed by Activity ID. */
const activityAttemptContexts = new Map<string, (NexusSerializationContext | undefined)[]>();
/** Task token and context of an Activity left to complete asynchronously, keyed by Activity ID. */
const asyncCompletions = new Map<string, { taskToken: Uint8Array; context?: NexusSerializationContext }>();

const activities = {
  async nexusStartedActivity(input: NexusStartedInput): Promise<string> {
    const info = activity.activityInfo();
    activityAttemptContexts.set(input.id, [
      ...(activityAttemptContexts.get(input.id) ?? []),
      info.nexusSerializationContext,
    ]);
    if (input.outcome === 'failure') {
      throw ApplicationFailure.create({
        message: 'nexus-started-failure',
        details: ['failure-detail'],
        nonRetryable: true,
      });
    }
    if (input.outcome === 'async') {
      asyncCompletions.set(input.id, { taskToken: info.taskToken, context: info.nexusSerializationContext });
      throw new activity.CompleteAsyncError();
    }
    if (info.attempt === 1) {
      // The next attempt decodes these details with the same context
      activity.heartbeat('heartbeat-detail');
      throw ApplicationFailure.retryable('retry');
    }
    if (info.heartbeatDetails !== 'heartbeat-detail') {
      throw ApplicationFailure.nonRetryable(`unexpected heartbeat details: ${JSON.stringify(info.heartbeatDetails)}`);
    }
    return input.value;
  },
};

const nexusStartedService = nexus.service('nexusStartedService', {
  startWorkflow: nexus.operation<NexusStartedInput, string>(),
  startActivity: nexus.operation<NexusStartedInput, string>(),
  updateWorkflow: nexus.operation<NexusUpdateInput, string>(),
});

// Built on demand: this module is also the Workflow bundle, where the Nexus package isn't available
function nexusStartedServiceHandler() {
  return nexus.serviceHandler(nexusStartedService, {
    startWorkflow: new temporalnexus.TemporalOperationHandler<NexusStartedInput, string>({
      async start(_ctx, client, input) {
        return await client.startWorkflow(nexusStartedWorkflow, { workflowId: input.id, args: [input] });
      },
    }),
    startActivity: new temporalnexus.TemporalOperationHandler<NexusStartedInput, string>({
      async start(_ctx, client, input) {
        return await client.startActivity('nexusStartedActivity', {
          id: input.id,
          args: [input],
          startToCloseTimeout: '10s',
          retry: { initialInterval: '100ms', maximumAttempts: 2 },
        });
      },
    }),
    updateWorkflow: new temporalnexus.TemporalOperationHandler<NexusUpdateInput, string>({
      async start(_ctx, client, input) {
        return await client.getWorkflowHandle(input.workflowId).update(nexusUpdate, {
          args: [input.value],
          updateId: input.updateId,
          waitForStage: WorkflowUpdateStage.ACCEPTED,
        });
      },
    }),
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Helpers

async function setup(
  t: ExecutionContext<Context>,
  operation: keyof typeof nexusStartedService.operations,
  workerClientInterceptors: WorkflowClientInterceptor[] = []
) {
  const h = helpers(t);
  const { endpointName } = await h.registerNexusEndpoint();
  const context: NexusSerializationContext = {
    type: 'nexus',
    endpoint: endpointName,
    service: nexusStartedService.name,
    operation,
  };
  const codec = nexusContextMarkerCodec({ [nexusCtx(endpointName, nexusStartedService.name, operation)]: MARKER });
  const client = makeClient(t.context, codec);
  const worker = await h.createWorker({
    activities,
    dataConverter: { payloadCodecs: [codec] },
    nexusServices: [nexusStartedServiceHandler()],
    interceptors: { client: { workflow: workerClientInterceptors } },
  });
  const nexusClient = client.nexus.createServiceClient({ endpoint: endpointName, service: nexusStartedService });
  return { client, worker, nexusClient, context, codec, taskQueue: h.taskQueue };
}

function makeClient({ env }: Context, codec: PayloadCodec): Client {
  return new Client({
    connection: env.client.connection,
    namespace: env.client.options.namespace,
    dataConverter: { payloadCodecs: [codec] },
  });
}

function marker(payload: Payload | null | undefined): string | undefined {
  const stamped = payload?.metadata?.[MARKER_KEY];
  return stamped != null ? new TextDecoder().decode(stamped) : undefined;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Tests

for (const outcome of ['result', 'failure', 'continueAsNew'] as const) {
  test(`Workflow started by a Nexus handler uses the Nexus context - ${outcome}`, async (t) => {
    const { client, worker, nexusClient, context } = await setup(t, 'startWorkflow');
    const workflowId = `nexus-started-workflow-${randomUUID()}`;
    const input: NexusStartedInput = { id: workflowId, value: 'nexus-value', outcome };

    await worker.runUntil(async () => {
      // This handle never started the Workflow, so it relies on the context the server returns,
      // including for the run after continue-as-new
      const handle = client.workflow.getHandle<typeof nexusStartedWorkflow>(workflowId);
      if (outcome === 'failure') {
        await t.throwsAsync(nexusClient.executeOperation('startWorkflow', input, { id: randomUUID() }), {
          instanceOf: NexusOperationFailureError,
        });
        const err = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
        t.true(err?.cause instanceof ApplicationFailure);
        t.deepEqual((err?.cause as ApplicationFailure).details, ['failure-detail']);
      } else {
        t.is(await nexusClient.executeOperation('startWorkflow', input, { id: randomUUID() }), 'nexus-value');
        t.is(await handle.result(), 'nexus-value');
      }

      // Read the raw events rather than decoding them: the marker identifies the context each
      // payload was encoded under, and decoding would strip it.
      const { history } = await client.workflowService.getWorkflowExecutionHistory({
        namespace: client.options.namespace,
        execution: { workflowId },
      });
      const events = history?.events ?? [];
      const started = events[0]?.workflowExecutionStartedEventAttributes;
      t.like(started?.propagatedNexusSerializationContext, {
        endpoint: context.endpoint,
        service: context.service,
        operation: context.operation,
      });
      // The input keeps the Workflow context
      t.true((started?.input?.payloads ?? []).every((payload) => marker(payload) == null));
      const closeEvent = events[events.length - 1];
      if (outcome === 'failure') {
        const failure = closeEvent?.workflowExecutionFailedEventAttributes?.failure;
        t.is(marker(failure?.applicationFailureInfo?.details?.payloads?.[0]), MARKER);
      } else {
        t.is(marker(closeEvent?.workflowExecutionCompletedEventAttributes?.result?.payloads?.[0]), MARKER);
      }
    });
  });
}

test('standalone Activity started by a Nexus handler uses the Nexus context', async (t) => {
  const { client, worker, nexusClient, context } = await setup(t, 'startActivity');
  const activityId = `nexus-started-activity-${randomUUID()}`;

  await worker.runUntil(async () => {
    const result = await nexusClient.executeOperation(
      'startActivity',
      { id: activityId, value: 'nexus-value', outcome: 'result' },
      { id: randomUUID() }
    );
    t.is(result, 'nexus-value');
    // Both attempts saw the context, and the second decoded the first's heartbeat details
    t.deepEqual(activityAttemptContexts.get(activityId), [context, context]);

    const handle = client.activity.getHandle(activityId);
    t.is(await handle.result(), 'nexus-value');
    const description = await handle.describe({
      includeOutcome: true,
      includeHeartbeatDetails: true,
      includeLastFailure: true,
    });
    t.is(await description.getResult(), 'nexus-value');
    t.is(await description.getHeartbeatDetails(), 'heartbeat-detail');
    t.true((await description.getLastFailure()) instanceof ApplicationFailure);
    t.is(marker(description.rawInfo.heartbeatDetails?.payloads?.[0]), MARKER);

    const raw = await client.workflowService.describeActivityExecution({
      namespace: client.options.namespace,
      activityId,
      includeInput: true,
      includeOutcome: true,
    });
    t.is(marker(raw.outcome?.result?.payloads?.[0]), MARKER);
    // The input keeps the Activity context
    t.true((raw.input?.payloads ?? []).every((payload) => marker(payload) == null));
  });
});

test('standalone Activity started by a Nexus handler fails with the Nexus context', async (t) => {
  const { client, worker, nexusClient } = await setup(t, 'startActivity');
  const activityId = `nexus-started-activity-${randomUUID()}`;

  await worker.runUntil(async () => {
    await t.throwsAsync(
      nexusClient.executeOperation(
        'startActivity',
        { id: activityId, value: '', outcome: 'failure' },
        { id: randomUUID() }
      ),
      { instanceOf: NexusOperationFailureError }
    );

    const handle = client.activity.getHandle(activityId);
    const err = await t.throwsAsync(handle.result(), { instanceOf: ActivityExecutionFailedError });
    t.true(err?.cause instanceof ApplicationFailure);
    t.deepEqual((err?.cause as ApplicationFailure).details, ['failure-detail']);
    const outcomeFailure = await (await handle.describe({ includeOutcome: true })).getOutcomeFailure();
    t.true(outcomeFailure instanceof ApplicationFailure);
    t.deepEqual((outcomeFailure as ApplicationFailure).details, ['failure-detail']);
  });
});

test('standalone Activity started by a Nexus handler completes asynchronously with the Nexus context', async (t) => {
  const { client, worker, nexusClient, context } = await setup(t, 'startActivity');
  const activityId = `nexus-started-activity-${randomUUID()}`;

  await worker.runUntil(async () => {
    const operation = await nexusClient.startOperation(
      'startActivity',
      { id: activityId, value: '', outcome: 'async' },
      { id: randomUUID() }
    );
    await waitUntil(async () => asyncCompletions.has(activityId), 10_000);
    const { taskToken, context: infoContext } = asyncCompletions.get(activityId)!;
    t.deepEqual(infoContext, context);

    await client.activity.heartbeat(taskToken, 'client-heartbeat', { serializationContext: infoContext });
    const description = await client.activity.getHandle(activityId).describe({ includeHeartbeatDetails: true });
    t.is(await description.getHeartbeatDetails(), 'client-heartbeat');
    t.is(marker(description.rawInfo.heartbeatDetails?.payloads?.[0]), MARKER);

    await client.activity.complete(taskToken, 'async-value', { serializationContext: infoContext });
    t.is(await operation.result(), 'async-value');
    t.is(await client.activity.getHandle(activityId).result(), 'async-value');
  });
});

for (const value of ['result', 'failure', 'rejection'] as const) {
  test(`Update sent by a Nexus handler uses the Nexus context - ${value}`, async (t) => {
    // Rejected Updates aren't stored in history, so the test reads the marker on the rejection the
    // handler's Client receives
    const rejectionMarkers: (string | undefined)[] = [];
    const captureRejection: WorkflowClientInterceptor = {
      async startUpdate(input, next) {
        const output = await next(input);
        if (output.outcome?.failure != null) {
          rejectionMarkers.push(marker(output.outcome.failure.applicationFailureInfo?.details?.payloads?.[0]));
        }
        return output;
      },
    };
    const { client, worker, nexusClient, context, codec, taskQueue } = await setup(t, 'updateWorkflow', [
      captureRejection,
    ]);
    const updateId = randomUUID();

    const history = await worker.runUntil(async () => {
      const handle = await client.workflow.start(nexusUpdatedWorkflow, {
        workflowId: `nexus-updated-workflow-${randomUUID()}`,
        taskQueue,
      });
      const operation = nexusClient.executeOperation(
        'updateWorkflow',
        { workflowId: handle.workflowId, updateId, value },
        { id: randomUUID() }
      );
      if (value === 'result') {
        t.is(await operation, 'result');
      } else {
        await t.throwsAsync(operation, { instanceOf: NexusOperationFailureError });
      }

      if (value === 'rejection') {
        t.deepEqual(rejectionMarkers, [MARKER]);
      } else {
        // This handle never sent the Update, so it relies on the context the server returns
        const updateHandle = handle.getUpdateHandle<string>(updateId);
        if (value === 'result') {
          t.is(await updateHandle.result(), 'result');
        } else {
          const err = await t.throwsAsync(updateHandle.result(), { instanceOf: WorkflowUpdateFailedError });
          t.true(err?.cause instanceof ApplicationFailure);
          t.deepEqual((err?.cause as ApplicationFailure).details, ['failure-detail']);
        }
      }

      await handle.signal(finishSignal);
      await handle.result();
      return await handle.fetchHistory();
    });

    const events = history.events ?? [];
    if (value !== 'rejection') {
      const accepted = events.find((e) => e.workflowExecutionUpdateAcceptedEventAttributes != null)
        ?.workflowExecutionUpdateAcceptedEventAttributes;
      t.like(accepted?.acceptedRequest?.propagatedNexusSerializationContext, {
        endpoint: context.endpoint,
        service: context.service,
        operation: context.operation,
      });
      // The input keeps the Workflow context
      t.true((accepted?.acceptedRequest?.input?.args?.payloads ?? []).every((payload) => marker(payload) == null));
      const completed = events.find((e) => e.workflowExecutionUpdateCompletedEventAttributes != null)
        ?.workflowExecutionUpdateCompletedEventAttributes;
      const outcomePayload =
        value === 'result'
          ? completed?.outcome?.success?.payloads?.[0]
          : completed?.outcome?.failure?.applicationFailureInfo?.details?.payloads?.[0];
      t.is(marker(outcomePayload), MARKER);
    }

    // Replaying re-runs the Update handler with the context from history
    await Worker.runReplayHistory(
      { workflowBundle: t.context.workflowBundle, dataConverter: { payloadCodecs: [codec] } },
      history
    );
  });
}
