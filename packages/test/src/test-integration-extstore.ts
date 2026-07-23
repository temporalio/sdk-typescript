/**
 * Integration tests for the external storage feature.
 */
import { randomUUID } from 'node:crypto';
import type { ConnectionLike } from '@temporalio/client';
import { Client } from '@temporalio/client';
import { ExternalStorage, type StorageDriverTargetInfo } from '@temporalio/common';
import { decodeReferencePayload, isReferencePayload } from '@temporalio/common/lib/internal-non-workflow';
import type { temporal } from '@temporalio/proto';
import * as activities from './activities';
import { makeFakeDriver } from './extstore-fake-driver';
import { helpers, makeTestFunction } from './helpers-integration';
import {
  externalStorageActivityInputOffload,
  externalStorageByteFidelity,
  externalStorageContinueAsNewSource,
  externalStorageEcho,
  externalStorageHeartbeatDetailsOffload,
  externalStorageOffload,
  externalStorageParentChildOffload,
  externalStorageQueryable,
  finishSignal,
  getBlobQuery,
} from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

test('large activity result is offloaded to external storage and retrieved once', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const driver = makeFakeDriver();
  const payloadSizeThreshold = 1024;
  const payloadSize = 4096;
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold });

  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const handle = await startWorkflow(externalStorageOffload, { args: [payloadSize] });
  const len = await worker.runUntil(handle.result());

  t.is(len, payloadSize);
  t.is(driver.storeCalls.length, 1);
  t.is(driver.retrieveCalls.length, 1);

  const { events } = await handle.fetchHistory();
  const completedEvent = events?.find((ev) => ev.activityTaskCompletedEventAttributes);
  const resultPayload = requireDefined(
    completedEvent?.activityTaskCompletedEventAttributes?.result?.payloads?.[0],
    'expected an ActivityTaskCompleted event with a result payload'
  );
  t.true(isReferencePayload(resultPayload), 'activity result in history should be a reference payload');

  const decoded = decodeReferencePayload(resultPayload);
  t.is(decoded.driverName, driver.name);
  // sizeBytes is the encoded Payload size (data + metadata), so it only exceeds payloadSize.
  t.true(decoded.sizeBytes >= payloadSize);
  t.true(decoded.sizeBytes > payloadSizeThreshold);
});

test('large activity input argument is offloaded and retrieved', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const driver = makeFakeDriver();
  const payloadSize = 4096;
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const handle = await startWorkflow(externalStorageActivityInputOffload, { args: [payloadSize] });
  const len = await worker.runUntil(handle.result());

  t.is(len, payloadSize);
  t.is(driver.storeCalls.length, 1);
  t.is(driver.retrieveCalls.length, 1);

  const { events } = await handle.fetchHistory();
  const scheduled = events?.find((ev) => ev.activityTaskScheduledEventAttributes);
  const inputPayload = requireDefined(
    scheduled?.activityTaskScheduledEventAttributes?.input?.payloads?.[0],
    'expected an ActivityTaskScheduled event with an input payload'
  );
  t.true(isReferencePayload(inputPayload), 'activity input in history should be a reference payload');
});

test('payloads at or below the threshold stay inline', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 4096 });
  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const smallSize = 1024;
  const handle = await startWorkflow(externalStorageOffload, { args: [smallSize] });
  const len = await worker.runUntil(handle.result());

  t.is(len, smallSize);
  t.is(driver.storeCalls.length, 0);
  t.is(driver.retrieveCalls.length, 0);

  const { events } = await handle.fetchHistory();
  const completedEvent = events?.find((ev) => ev.activityTaskCompletedEventAttributes);
  const resultPayload = requireDefined(
    completedEvent?.activityTaskCompletedEventAttributes?.result?.payloads?.[0],
    'expected an ActivityTaskCompleted event with a result payload'
  );
  t.false(isReferencePayload(resultPayload), 'below-threshold activity result should stay inline');
});

test('driverSelector routes offloaded payloads to the chosen driver', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const driverA = makeFakeDriver({ name: 'a' });
  const driverB = makeFakeDriver({ name: 'b' });
  const payloadSize = 4096;
  let observedTarget: StorageDriverTargetInfo | undefined;
  const externalStorage = new ExternalStorage({
    drivers: [driverA, driverB],
    // Route on the store target. produceLargePayload runs inside a workflow, so its result carries
    // the owning workflow execution as the target.
    driverSelector: (context) => {
      observedTarget = context.target;
      return context.target?.type === 'externalStorageOffload' ? driverB : driverA;
    },
    payloadSizeThreshold: 1024,
  });
  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const handle = await startWorkflow(externalStorageOffload, { args: [payloadSize] });
  const len = await worker.runUntil(handle.result());

  t.is(len, payloadSize);
  t.is(observedTarget?.kind, 'workflow');
  t.is(observedTarget?.type, 'externalStorageOffload');
  t.is(driverA.storeCalls.length, 0);
  t.is(driverB.storeCalls.length, 1);
  t.is(driverB.retrieveCalls.length, 1);

  const { events } = await handle.fetchHistory();
  const completedEvent = events?.find((ev) => ev.activityTaskCompletedEventAttributes);
  const resultPayload = requireDefined(
    completedEvent?.activityTaskCompletedEventAttributes?.result?.payloads?.[0],
    'expected an ActivityTaskCompleted event with a result payload'
  );
  t.is(decodeReferencePayload(resultPayload).driverName, 'b');
});

test('offloaded payload round-trips byte-for-byte', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const driver = makeFakeDriver();
  const payloadSize = 4096;
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const handle = await startWorkflow(externalStorageByteFidelity, { args: [payloadSize] });
  const bytesMatch = await worker.runUntil(handle.result());

  t.true(bytesMatch, 'retrieved bytes should exactly match the produced pattern');
  t.is(driver.storeCalls.length, 1);
  t.is(driver.retrieveCalls.length, 1);
});

test('large heartbeat details are offloaded and recovered on retry', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const driver = makeFakeDriver();
  const payloadSize = 4096;
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const handle = await startWorkflow(externalStorageHeartbeatDetailsOffload, { args: [payloadSize] });
  const len = await worker.runUntil(handle.result());

  t.is(len, payloadSize);
  t.true(driver.storeCalls.length >= 1);
  t.true(driver.retrieveCalls.length >= 1);

  // The heartbeat store carried the owning workflow as its target (the activity is workflow-bound).
  const target = requireDefined(driver.storeCalls[0], 'expected a heartbeat store call').context.target;
  t.is(target?.kind, 'workflow');
  t.is(target?.type, 'externalStorageHeartbeatDetailsOffload');
});

test('child workflow input and result are offloaded in both directions', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const driver = makeFakeDriver();
  const payloadSize = 4096;
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const handle = await startWorkflow(externalStorageParentChildOffload, { args: [payloadSize] });
  const len = await worker.runUntil(handle.result());

  t.is(len, payloadSize);
  // [0] child input (parent's StartChildWorkflowExecution command), [1] child result (child's
  // completion) — both keyed under the child's type. The parent's final result stays inline.
  // The child's id/runId are runtime-generated, so only kind and type are asserted.
  t.is(driver.storeCalls.length, 2);
  t.is(driver.retrieveCalls.length, 2);
  t.is(driver.storeCalls[0].context.target?.kind, 'workflow');
  t.is(driver.storeCalls[0].context.target?.type, 'externalStorageEcho');
  t.is(driver.storeCalls[1].context.target?.kind, 'workflow');
  t.is(driver.storeCalls[1].context.target?.type, 'externalStorageEcho');
});

test('continue-as-new offloads a large argument keyed under the target workflow type', async (t) => {
  const { createWorker, taskQueue } = helpers(t);

  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const sizeBytes = 4096;

  const worker = await createWorker({ dataConverter: { externalStorage } });
  const client = new Client({ connection: t.context.env.connection, dataConverter: { externalStorage } });

  const workflowId = randomUUID();
  const handle = await client.workflow.start(externalStorageContinueAsNewSource, {
    taskQueue,
    workflowId,
    args: [sizeBytes],
  });
  const result = await worker.runUntil(handle.result());
  t.is(result, sizeBytes, 'the continue-as-new target should observe the full offloaded argument');

  // The ContinueAsNew argument, offloaded on the source's completion but keyed under the new run.
  t.is(driver.storeCalls.length, 1);
  t.deepEqual(driver.storeCalls[0].context.target, {
    kind: 'workflow',
    namespace: 'default',
    id: workflowId,
    runId: undefined,
    type: 'externalStorageContinueAsNewTarget',
  });
});

test('a transient workflow-completion store failure retries the workflow task and recovers', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  // Activity input is offloaded on the workflow-task completion, so this covers the completion store.
  const driver = makeFakeDriver({ failFirstStore: true });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const payloadSize = 4096;
  const handle = await startWorkflow(externalStorageActivityInputOffload, { args: [payloadSize] });
  const len = await worker.runUntil(handle.result());

  t.is(len, payloadSize);
  // Not exact: a workflow-task failure evicts and replays the workflow, so the retry count can vary.
  t.true(driver.storeCalls.length >= 2);

  // Only reliable because we fail exactly once: Temporal's transient-workflow-task optimization
  // doesn't persist every consecutive WFT failure to history.
  const { events } = await handle.fetchHistory();
  const wftFailure = requireDefined(
    events?.find((ev) => ev.workflowTaskFailedEventAttributes)?.workflowTaskFailedEventAttributes?.failure,
    'expected a WorkflowTaskFailed event caused by the transient store failure'
  );
  t.true(
    wftFailure.message?.includes('transient store failure') ?? false,
    `WorkflowTaskFailed should reference the store failure, got: ${wftFailure.message}`
  );
});

test('a transient workflow-activation retrieve failure retries the workflow task and recovers', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  // Activity result is retrieved into the workflow activation, so this covers the activation retrieve.
  const driver = makeFakeDriver({ failFirstRetrieve: true });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const payloadSize = 4096;
  const handle = await startWorkflow(externalStorageOffload, { args: [payloadSize] });
  const len = await worker.runUntil(handle.result());

  t.is(len, payloadSize);
  // Not exact: a workflow-task failure evicts and replays the workflow, so the retry count can vary.
  t.true(driver.retrieveCalls.length >= 2);

  const { events } = await handle.fetchHistory();
  const wftFailure = requireDefined(
    events?.find((ev) => ev.workflowTaskFailedEventAttributes)?.workflowTaskFailedEventAttributes?.failure,
    'expected a WorkflowTaskFailed event caused by the transient retrieve failure'
  );
  t.true(
    wftFailure.message?.includes('transient retrieve failure') ?? false,
    `WorkflowTaskFailed should reference the retrieve failure, got: ${wftFailure.message}`
  );
});

test('a transient activity result store failure retries the activity and recovers', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  // The activity result is offloaded on the activity-task completion; failing the first store covers
  // that path.
  const driver = makeFakeDriver({ failFirstStore: true });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const payloadSize = 4096;
  const handle = await startWorkflow(externalStorageOffload, { args: [payloadSize] });
  const len = await worker.runUntil(handle.result());

  t.is(len, payloadSize);
  // Recovered activity attempts aren't recorded as history events, so the retry is observed via the
  // driver call count rather than an ActivityTaskFailed event.
  t.true(driver.storeCalls.length >= 2);
});

test('a transient activity input retrieve failure retries the activity and recovers', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  // The activity input is offloaded, then retrieved when the worker delivers the activity task;
  // failing the first retrieve covers that path.
  const driver = makeFakeDriver({ failFirstRetrieve: true });
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const worker = await createWorker({ activities, dataConverter: { externalStorage } });

  const payloadSize = 4096;
  const handle = await startWorkflow(externalStorageActivityInputOffload, { args: [payloadSize] });
  const len = await worker.runUntil(handle.result());

  t.is(len, payloadSize);
  t.true(driver.retrieveCalls.length >= 2);
});

test('client offloads a large start argument and retrieves a large result', async (t) => {
  const { createWorker, taskQueue } = helpers(t);

  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const data = new Uint8Array(4096).fill(3);

  const worker = await createWorker({ dataConverter: { externalStorage } });
  const client = new Client({ connection: t.context.env.connection, dataConverter: { externalStorage } });

  const workflowId = randomUUID();
  const handle = await client.workflow.start(externalStorageEcho, { taskQueue, workflowId, args: [data] });
  const result = await worker.runUntil(handle.result());
  t.deepEqual(result, data);

  // Raw history is fetched through a converter without external storage; otherwise the references
  // below would be retrieved away before we can assert on them.
  const { events } = await t.context.env.client.workflow.getHandle(workflowId).fetchHistory();
  const startArg = events?.find((e) => e.workflowExecutionStartedEventAttributes)
    ?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
  if (startArg == null) throw new Error('expected a start input payload');
  t.true(isReferencePayload(startArg), 'start argument should be offloaded by the client');

  const resultPayload = events?.find((e) => e.workflowExecutionCompletedEventAttributes)
    ?.workflowExecutionCompletedEventAttributes?.result?.payloads?.[0];
  if (resultPayload == null) throw new Error('expected a completed result payload');
  t.true(isReferencePayload(resultPayload), 'workflow result should be a reference before the client retrieves it');

  // [0] client-side start argument, [1] Worker-side completion result.
  t.is(driver.storeCalls.length, 2);
  t.deepEqual(driver.storeCalls[0].context.target, {
    kind: 'workflow',
    namespace: 'default',
    id: workflowId,
    type: 'externalStorageEcho',
  });
  t.deepEqual(driver.storeCalls[1].context.target, {
    kind: 'workflow',
    namespace: 'default',
    id: workflowId,
    runId: handle.firstExecutionRunId,
    type: 'externalStorageEcho',
  });
});

test('client retrieves an offloaded query result', async (t) => {
  const { createWorker, taskQueue } = helpers(t);

  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const sizeBytes = 4096;
  const expected = new Uint8Array(sizeBytes).fill(7);

  const worker = await createWorker({ dataConverter: { externalStorage } });
  const client = new Client({ connection: t.context.env.connection, dataConverter: { externalStorage } });

  const workflowId = randomUUID();
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(externalStorageQueryable, { taskQueue, workflowId, args: [sizeBytes] });
    const retrievesBefore = driver.retrieveCalls.length;
    const blob = await handle.query(getBlobQuery);
    t.deepEqual(blob, expected);
    t.true(driver.retrieveCalls.length > retrievesBefore, 'client should retrieve the offloaded query result');
    await handle.signal(finishSignal);
    await handle.result();
  });
});

test('AsyncCompletionClient.complete offloads a large result', async (t) => {
  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });

  let recorded: temporal.api.workflowservice.v1.IRespondActivityTaskCompletedRequest | undefined;
  const connection = {
    workflowService: {
      respondActivityTaskCompleted: async (
        req: temporal.api.workflowservice.v1.IRespondActivityTaskCompletedRequest
      ) => {
        recorded = req;
      },
    },
    plugins: [],
  } as unknown as ConnectionLike;
  const client = new Client({ connection, dataConverter: { externalStorage } });

  await client.activity.complete(new Uint8Array([1]), new Uint8Array(4096).fill(9));

  t.is(driver.storeCalls.length, 1);
  const payload = recorded?.result?.payloads?.[0];
  if (payload == null) throw new Error('expected a result payload');
  t.true(isReferencePayload(payload), 'the async completion result should be offloaded before sending');
  const decoded = decodeReferencePayload(payload);
  t.is(decoded.driverName, driver.name);
  t.true(decoded.sizeBytes >= 4096);
  t.deepEqual(driver.storeCalls[0].context.target, { kind: 'workflow', namespace: 'default' });
});

test('AsyncCompletionClient.complete by ID targets the Workflow for a Workflow Activity', async (t) => {
  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });

  const connection = {
    workflowService: { respondActivityTaskCompletedById: async () => ({}) },
    plugins: [],
  } as unknown as ConnectionLike;
  const client = new Client({ connection, dataConverter: { externalStorage } });

  await client.activity.complete(
    { workflowId: 'wf-1', runId: 'run-1', activityId: 'act-1' },
    new Uint8Array(4096).fill(9)
  );

  t.is(driver.storeCalls.length, 1);
  t.deepEqual(driver.storeCalls[0].context.target, {
    kind: 'workflow',
    namespace: 'default',
    id: 'wf-1',
    runId: 'run-1',
  });
});

test('AsyncCompletionClient.complete by ID targets the Activity for a Standalone Activity', async (t) => {
  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });

  const connection = {
    workflowService: { respondActivityTaskCompletedById: async () => ({}) },
    plugins: [],
  } as unknown as ConnectionLike;
  const client = new Client({ connection, dataConverter: { externalStorage } });

  await client.activity.complete({ runId: 'run-2', activityId: 'act-2' }, new Uint8Array(4096).fill(9));

  t.is(driver.storeCalls.length, 1);
  t.deepEqual(driver.storeCalls[0].context.target, {
    kind: 'activity',
    namespace: 'default',
    id: 'act-2',
    runId: 'run-2',
  });
});

test('signalWithStart offloads a large workflow argument and targets the workflow type', async (t) => {
  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });

  let req: temporal.api.workflowservice.v1.ISignalWithStartWorkflowExecutionRequest | undefined;
  const connection = {
    workflowService: {
      signalWithStartWorkflowExecution: async (
        r: temporal.api.workflowservice.v1.ISignalWithStartWorkflowExecutionRequest
      ) => {
        req = r;
        return { runId: 'run-1' };
      },
    },
    plugins: [],
  } as unknown as ConnectionLike;
  const client = new Client({ connection, dataConverter: { externalStorage } });

  await client.workflow.signalWithStart('myWorkflow', {
    workflowId: 'wf-1',
    taskQueue: 'q',
    args: [new Uint8Array(4096).fill(1)],
    signal: 'mySignal',
  });

  t.is(driver.storeCalls.length, 1);
  t.true(isReferencePayload(req!.input!.payloads![0]), 'the workflow argument should be offloaded before sending');
  t.deepEqual(driver.storeCalls[0].context.target, {
    kind: 'workflow',
    namespace: 'default',
    id: 'wf-1',
    type: 'myWorkflow',
  });
});

test('activity-client start offloads a large input and targets the activity', async (t) => {
  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });

  let startReq: temporal.api.workflowservice.v1.IStartActivityExecutionRequest | undefined;
  const connection = {
    workflowService: {
      startActivityExecution: async (req: temporal.api.workflowservice.v1.IStartActivityExecutionRequest) => {
        startReq = req;
        return { runId: 'run-1' };
      },
    },
    plugins: [],
  } as unknown as ConnectionLike;
  const client = new Client({ connection, dataConverter: { externalStorage } });

  await client.activity.start('myActivity', {
    id: 'act-1',
    taskQueue: 'q',
    args: [new Uint8Array(4096).fill(8)],
    scheduleToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 1 },
  });

  t.is(driver.storeCalls.length, 1);
  t.true(isReferencePayload(startReq!.input!.payloads![0]), 'the activity input should be offloaded before sending');
  t.deepEqual(driver.storeCalls[0].context.target, {
    kind: 'activity',
    namespace: 'default',
    id: 'act-1',
    type: 'myActivity',
  });
});

test('client offloads a large workflow memo and retrieves it via describe', async (t) => {
  const { createWorker, taskQueue } = helpers(t);

  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const memoBlob = new Uint8Array(4096).fill(5);

  const worker = await createWorker({ dataConverter: { externalStorage } });
  const client = new Client({ connection: t.context.env.connection, dataConverter: { externalStorage } });

  const workflowId = randomUUID();
  const handle = await client.workflow.start(externalStorageEcho, {
    taskQueue,
    workflowId,
    args: [new Uint8Array(1)],
    memo: { blob: memoBlob },
  });
  await worker.runUntil(handle.result());

  t.true(driver.storeCalls.length >= 1, 'the large memo should have been offloaded on start');
  const description = await handle.describe();
  t.deepEqual(description.memo?.blob, memoBlob);
});

// Mocked rather than run against the ephemeral server: describing a just-created schedule there
// times out on slower CI runners (test-schedules.ts covers schedules against a real server).
test('schedule create offloads a large memo and describe retrieves it', async (t) => {
  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });
  const memoBlob = new Uint8Array(4096).fill(6);

  let createReq: temporal.api.workflowservice.v1.ICreateScheduleRequest | undefined;
  const connection = {
    workflowService: {
      createSchedule: async (req: temporal.api.workflowservice.v1.ICreateScheduleRequest) => {
        createReq = req;
        return {};
      },
      describeSchedule: async () => ({
        schedule: {
          spec: {},
          action: { startWorkflow: { workflowType: { name: 'w' }, taskQueue: { name: 'q' } } },
        },
        info: { createTime: { seconds: 0, nanos: 0 } },
        memo: { fields: { blob: createReq!.memo!.fields!.blob } },
      }),
    },
    plugins: [],
  } as unknown as ConnectionLike;
  const client = new Client({ connection, dataConverter: { externalStorage } });

  const handle = await client.schedule.create({
    scheduleId: 'sched-1',
    spec: {},
    action: { type: 'startWorkflow', workflowType: 'w', taskQueue: 'q' },
    memo: { blob: memoBlob },
  });

  t.is(driver.storeCalls.length, 1);
  t.true(isReferencePayload(createReq!.memo!.fields!.blob), 'schedule memo should be offloaded on create');
  const target = driver.storeCalls[0].context.target;
  t.is(target?.kind, 'workflow');
  t.is(target?.namespace, 'default');
  t.is(target?.kind === 'workflow' ? target.type : undefined, 'w');

  const description = await handle.describe();
  t.deepEqual(description.memo?.blob, memoBlob);
});
