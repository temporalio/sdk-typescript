/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import type { Payload } from '@temporalio/common';
import { ExternalStorage } from '@temporalio/common/lib/converter/extstore';
import {
  isReferencePayload,
  retrieveWorkflowActivation,
  storeWorkflowActivationCompletion,
} from '@temporalio/common/lib/internal-non-workflow';
import { encode } from '@temporalio/common/lib/encoding';
import { METADATA_ENCODING_KEY } from '@temporalio/common/lib/converter/types';
import type { coresdk } from '@temporalio/proto';
import { makeFakeDriver } from './extstore-fake-driver';

/** Build a Payload whose proto-encoded size is at least `bodyBytes`, filled with `fill`. */
function makePayload(bodyBytes: number, fill = 0): Payload {
  return {
    metadata: { [METADATA_ENCODING_KEY]: encode('binary/plain') },
    data: new Uint8Array(bodyBytes).fill(fill),
  };
}

function externalStorageWith(driver = makeFakeDriver({ name: 's3' }), payloadSizeThreshold = 96) {
  return { driver, externalStorage: new ExternalStorage({ drivers: [driver], payloadSizeThreshold }) };
}

const WORKFLOW_TARGET = { kind: 'workflow', namespace: 'ns', id: 'wf-1', runId: 'run-1' } as const;

test('store offloads a large payload at a singular site and threads the target to the driver', async (t) => {
  const { driver, externalStorage } = externalStorageWith();
  const completion: coresdk.workflow_completion.IWorkflowActivationCompletion = {
    successful: { commands: [{ completeWorkflowExecution: { result: makePayload(256) } }] },
  };

  await storeWorkflowActivationCompletion(externalStorage, completion, { target: WORKFLOW_TARGET });

  const result = completion.successful!.commands![0]!.completeWorkflowExecution!.result!;
  t.true(isReferencePayload(result));
  t.is(driver.storeCalls.length, 1);
  t.deepEqual(driver.storeCalls[0]!.context.target, WORKFLOW_TARGET);
});

test('store offloads only above-threshold payloads at a repeated site', async (t) => {
  const { externalStorage } = externalStorageWith();
  const small = makePayload(0);
  const completion: coresdk.workflow_completion.IWorkflowActivationCompletion = {
    successful: { commands: [{ scheduleActivity: { arguments: [makePayload(256), small] } }] },
  };

  await storeWorkflowActivationCompletion(externalStorage, completion, { target: WORKFLOW_TARGET });

  const args = completion.successful!.commands![0]!.scheduleActivity!.arguments!;
  t.true(isReferencePayload(args[0]!));
  t.deepEqual(args[1], small);
});

test('store then retrieve round-trips the original payload bytes through a worker message', async (t) => {
  const { driver, externalStorage } = externalStorageWith();
  const original = makePayload(256, 7);
  const completion: coresdk.workflow_completion.IWorkflowActivationCompletion = {
    successful: { commands: [{ completeWorkflowExecution: { result: original } }] },
  };

  await storeWorkflowActivationCompletion(externalStorage, completion, { target: WORKFLOW_TARGET });
  const reference = completion.successful!.commands![0]!.completeWorkflowExecution!.result!;
  t.true(isReferencePayload(reference));

  // The reference produced on the outbound path arrives back on a later inbound activation.
  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: [{ resolveActivity: { result: { completed: { result: reference } } } }],
  };
  await retrieveWorkflowActivation(externalStorage, activation);

  const retrieved = activation.jobs![0]!.resolveActivity!.result!.completed!.result!;
  t.false(isReferencePayload(retrieved));
  t.deepEqual(retrieved, original);
  t.is(driver.retrieveCalls.length, 1);
});
