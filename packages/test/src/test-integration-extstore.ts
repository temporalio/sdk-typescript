/**
 * Integration tests for the external storage feature.
 */
import { ExternalStorage } from '@temporalio/common';
import * as activities from './activities';
import { makeFakeDriver } from './extstore-fake-driver';
import { helpers, makeTestFunction } from './helpers-integration';
import { externalStorageOffload } from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('large activity result is offloaded to external storage and retrieved once', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

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

  const len = await worker.runUntil(executeWorkflow(externalStorageOffload, { args: [payloadSize] }));

  // Round-trip correctness: the offloaded payload was retrieved and reassembled intact.
  t.is(len, payloadSize);
  // Exactly the one large activity result was offloaded, and it was retrieved exactly once
  // when the worker decoded the activity result for the workflow.
  t.is(driver.storeCalls.length, 1);
  t.is(driver.retrieveCalls.length, 1);
});
