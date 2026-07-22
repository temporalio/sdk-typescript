/**
 * Integration tests for the external storage feature.
 */
import { ExternalStorage, type StorageDriverTargetInfo } from '@temporalio/common';
import { decodeReferencePayload, isReferencePayload } from '@temporalio/common/lib/internal-non-workflow';
import * as activities from './activities';
import { makeFakeDriver } from './extstore-fake-driver';
import { helpers, makeTestFunction } from './helpers-integration';
import {
  externalStorageActivityInputOffload,
  externalStorageByteFidelity,
  externalStorageHeartbeatDetailsOffload,
  externalStorageOffload,
  externalStorageParentChildOffload,
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
  // Stores: child input (by parent) + child result (by child). Retrieves: each read once. The
  // parent's final result is small and stays inline.
  t.is(driver.storeCalls.length, 2);
  t.is(driver.retrieveCalls.length, 2);
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
