/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import type { Payload } from '@temporalio/common';
import { ExternalStorage } from '@temporalio/common/lib/converter/extstore';
import {
  ExternalStorageRunner,
  extstoreRetrieveOptions,
  extstoreStoreOptions,
  isReferencePayload,
  visitActivityTask,
  visitActivityTaskCompletion,
  visitNexusTask,
  visitNexusTaskCompletion,
  visitWorkflowActivation,
  visitWorkflowActivationCompletion,
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

/** Offload a payload through the runner and return the resulting reference payload. */
async function toReference(externalStorage: ExternalStorage, payload: Payload): Promise<Payload> {
  const [reference] = await new ExternalStorageRunner(externalStorage).store([payload]);
  return reference!;
}

const WORKFLOW_TARGET = { kind: 'workflow', namespace: 'ns', id: 'wf-1', runId: 'run-1' } as const;

test('workflow store offloads a large payload and threads the target to the driver', async (t) => {
  const { driver, externalStorage } = externalStorageWith();
  const completion: coresdk.workflow_completion.IWorkflowActivationCompletion = {
    successful: { commands: [{ completeWorkflowExecution: { result: makePayload(256) } }] },
  };

  await visitWorkflowActivationCompletion(
    completion,
    extstoreStoreOptions(externalStorage, { initialTarget: WORKFLOW_TARGET })
  );

  const result = completion.successful!.commands![0]!.completeWorkflowExecution!.result!;
  t.true(isReferencePayload(result));
  t.is(driver.storeCalls.length, 1);
  t.deepEqual(driver.storeCalls[0]!.context.target, WORKFLOW_TARGET);
});

test('workflow store offloads only above-threshold payloads at a repeated site', async (t) => {
  const { externalStorage } = externalStorageWith();
  const small = makePayload(0);
  const completion: coresdk.workflow_completion.IWorkflowActivationCompletion = {
    successful: { commands: [{ scheduleActivity: { arguments: [makePayload(256), small] } }] },
  };

  await visitWorkflowActivationCompletion(
    completion,
    extstoreStoreOptions(externalStorage, { initialTarget: WORKFLOW_TARGET })
  );

  const args = completion.successful!.commands![0]!.scheduleActivity!.arguments!;
  t.true(isReferencePayload(args[0]!));
  t.deepEqual(args[1], small);
});

test('workflow store applies a per-command derived target', async (t) => {
  const { driver, externalStorage } = externalStorageWith();
  const childTarget = { kind: 'workflow', namespace: 'ns', id: 'child-1' } as const;
  const completion: coresdk.workflow_completion.IWorkflowActivationCompletion = {
    successful: {
      commands: [
        { completeWorkflowExecution: { result: makePayload(256, 1) } },
        { startChildWorkflowExecution: { workflowId: 'child-1', input: [makePayload(256, 2)] } },
      ],
    },
  };

  await visitWorkflowActivationCompletion(
    completion,
    extstoreStoreOptions(externalStorage, {
      initialTarget: WORKFLOW_TARGET,
      // Stand-in for the worker's command→target mapping: the child command retargets its payloads.
      deriveContext: (_message, typeName, context) =>
        typeName === 'coresdk.workflow_commands.StartChildWorkflowExecution' ? childTarget : context,
    })
  );

  const targets = driver.storeCalls.map((call) => call.context.target?.id);
  t.true(targets.includes('wf-1'), 'workflow result stored against the workflow');
  t.true(targets.includes('child-1'), 'child input stored against the child workflow');
});

test('workflow store then retrieve round-trips the original payload bytes', async (t) => {
  const { externalStorage } = externalStorageWith();
  const original = makePayload(256, 7);
  const completion: coresdk.workflow_completion.IWorkflowActivationCompletion = {
    successful: { commands: [{ completeWorkflowExecution: { result: original } }] },
  };

  await visitWorkflowActivationCompletion(
    completion,
    extstoreStoreOptions(externalStorage, { initialTarget: WORKFLOW_TARGET })
  );
  const reference = completion.successful!.commands![0]!.completeWorkflowExecution!.result!;
  t.true(isReferencePayload(reference));

  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: [{ resolveActivity: { result: { completed: { result: reference } } } }],
  };
  await visitWorkflowActivation(activation, extstoreRetrieveOptions(externalStorage));

  const retrieved = activation.jobs![0]!.resolveActivity!.result!.completed!.result!;
  t.false(isReferencePayload(retrieved));
  t.deepEqual(retrieved, original);
});

test('activity task completion store offloads the result payload', async (t) => {
  const { driver, externalStorage } = externalStorageWith();
  const completion: coresdk.IActivityTaskCompletion = {
    taskToken: new Uint8Array([1]),
    result: { completed: { result: makePayload(256) } },
  };

  await visitActivityTaskCompletion(completion, extstoreStoreOptions(externalStorage));

  t.true(isReferencePayload(completion.result!.completed!.result!));
  t.is(driver.storeCalls.length, 1);
});

test('activity task retrieve resolves the activity input', async (t) => {
  const { externalStorage } = externalStorageWith();
  const input = makePayload(256, 3);
  const task: coresdk.activity_task.IActivityTask = {
    start: { input: [await toReference(externalStorage, input)] },
  };

  await visitActivityTask(task, extstoreRetrieveOptions(externalStorage));

  t.deepEqual(task.start!.input![0], input);
});

test('nexus task completion store offloads the sync result payload', async (t) => {
  const { externalStorage } = externalStorageWith();
  const completion: coresdk.nexus.INexusTaskCompletion = {
    completed: { startOperation: { syncSuccess: { payload: makePayload(256) } } },
  };

  await visitNexusTaskCompletion(completion, extstoreStoreOptions(externalStorage));

  t.true(isReferencePayload(completion.completed!.startOperation!.syncSuccess!.payload!));
});

test('nexus task retrieve resolves the request payload', async (t) => {
  const { externalStorage } = externalStorageWith();
  const requestPayload = makePayload(256, 5);
  const task: coresdk.nexus.INexusTask = {
    task: { request: { startOperation: { payload: await toReference(externalStorage, requestPayload) } } },
  };

  await visitNexusTask(task, extstoreRetrieveOptions(externalStorage));

  t.deepEqual(task.task!.request!.startOperation!.payload, requestPayload);
});
