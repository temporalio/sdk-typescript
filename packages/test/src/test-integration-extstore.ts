/**
 * Integration tests for the external storage feature.
 */
import { ExternalStorage } from '@temporalio/common';
import { decodeReferencePayload, isReferencePayload } from '@temporalio/common/lib/internal-non-workflow';
import * as activities from './activities';
import { makeFakeDriver } from './extstore-fake-driver';
import { helpers, makeTestFunction } from './helpers-integration';
import { externalStorageOffload } from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('large activity result is offloaded to external storage and retrieved once', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const driver = makeFakeDriver();
  // Small but non-zero threshold: small payloads (the activity's numeric arg and the
  // workflow's numeric result) stay inline; only the large activity result is offloaded.
  const payloadSizeThreshold = 1024;
  const payloadSize = 4096;
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold });

  const worker = await createWorker({
    activities,
    dataConverter: { externalStorage },
  });

  const handle = await startWorkflow(externalStorageOffload, { args: [payloadSize] });
  const len = await worker.runUntil(handle.result());

  // Round-trip correctness: the offloaded payload was retrieved and reassembled intact.
  t.is(len, payloadSize);
  // Exactly the one large activity result was offloaded, and it was retrieved exactly once
  // when the worker decoded the activity result for the workflow.
  t.is(driver.storeCalls.length, 1);
  t.is(driver.retrieveCalls.length, 1);

  // The activity result stored in workflow history is an external-storage reference.
  const { events } = await handle.fetchHistory();
  const completedEvent = events?.find((ev) => ev.activityTaskCompletedEventAttributes);
  const resultPayload = completedEvent?.activityTaskCompletedEventAttributes?.result?.payloads?.[0];
  // Narrow `resultPayload` to non-undefined so the checks below don't need non-null assertions.
  if (resultPayload == null) throw new Error('expected an ActivityTaskCompleted event with a result payload');
  t.true(isReferencePayload(resultPayload), 'activity result in history should be a reference payload');

  // The reference points at the configured driver and records the original payload size (the encoded
  // Payload wraps at least our `payloadSize` data bytes, plus metadata, and exceeds the threshold).
  const decoded = decodeReferencePayload(resultPayload);
  t.is(decoded.driverName, driver.name);
  t.true(decoded.sizeBytes >= payloadSize);
  t.true(decoded.sizeBytes > payloadSizeThreshold);
});
