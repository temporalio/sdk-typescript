/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import type { Payload } from '@temporalio/common';
import { ExternalStorageNotConfiguredError } from '@temporalio/common';
import { ExternalStorage, type StorageDriver } from '@temporalio/common/lib/converter/extstore';
import {
  ExternalStorageRunner,
  extstoreInboundOptions,
  extstoreStoreOptions,
  isReferencePayload,
  visit,
  walkActivityHeartbeat,
  walkActivityTask,
  walkActivityTaskCompletion,
  walkNexusTask,
  walkNexusTaskCompletion,
  walkQueryWorkflowResponse,
  walkStartWorkflowExecutionRequest,
  walkWorkflowActivation,
  walkWorkflowActivationCompletion,
} from '@temporalio/common/lib/internal-non-workflow';
import { encode } from '@temporalio/common/lib/encoding';
import { METADATA_ENCODING_KEY } from '@temporalio/common/lib/converter/types';
import type { coresdk, temporal } from '@temporalio/proto';
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

  await visit(
    completion,
    walkWorkflowActivationCompletion,
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

  await visit(
    completion,
    walkWorkflowActivationCompletion,
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

  await visit(
    completion,
    walkWorkflowActivationCompletion,
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

test('workflow store leaves search attributes inline while offloading siblings', async (t) => {
  const { externalStorage } = externalStorageWith();
  const searchAttr = makePayload(256, 8);
  const completion: coresdk.workflow_completion.IWorkflowActivationCompletion = {
    successful: {
      commands: [
        {
          startChildWorkflowExecution: {
            workflowId: 'child-1',
            input: [makePayload(256, 1)],
            searchAttributes: { indexedFields: { CustomKey: searchAttr } },
          },
        },
      ],
    },
  };

  await visit(
    completion,
    walkWorkflowActivationCompletion,
    extstoreStoreOptions(externalStorage, { initialTarget: WORKFLOW_TARGET })
  );

  const command = completion.successful!.commands![0]!.startChildWorkflowExecution!;
  t.true(isReferencePayload(command.input![0]!), 'input is offloaded');
  t.deepEqual(command.searchAttributes!.indexedFields!.CustomKey, searchAttr, 'search attribute left untouched');
});

test('workflow store then retrieve round-trips the original payload bytes', async (t) => {
  const { externalStorage } = externalStorageWith();
  const original = makePayload(256, 7);
  const completion: coresdk.workflow_completion.IWorkflowActivationCompletion = {
    successful: { commands: [{ completeWorkflowExecution: { result: original } }] },
  };

  await visit(
    completion,
    walkWorkflowActivationCompletion,
    extstoreStoreOptions(externalStorage, { initialTarget: WORKFLOW_TARGET })
  );
  const reference = completion.successful!.commands![0]!.completeWorkflowExecution!.result!;
  t.true(isReferencePayload(reference));

  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: [{ resolveActivity: { result: { completed: { result: reference } } } }],
  };
  await visit(activation, walkWorkflowActivation, extstoreInboundOptions(externalStorage));

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

  await visit(completion, walkActivityTaskCompletion, extstoreStoreOptions(externalStorage));

  t.true(isReferencePayload(completion.result!.completed!.result!));
  t.is(driver.storeCalls.length, 1);
});

test('activity heartbeat store offloads the details payload', async (t) => {
  const { externalStorage } = externalStorageWith();
  const heartbeat: coresdk.IActivityHeartbeat = { taskToken: new Uint8Array([1]), details: [makePayload(256)] };

  await visit(heartbeat, walkActivityHeartbeat, extstoreStoreOptions(externalStorage));

  t.true(isReferencePayload(heartbeat.details![0]!));
});

test('activity task retrieve resolves the activity input', async (t) => {
  const { externalStorage } = externalStorageWith();
  const input = makePayload(256, 3);
  const task: coresdk.activity_task.IActivityTask = {
    start: { input: [await toReference(externalStorage, input)] },
  };

  await visit(task, walkActivityTask, extstoreInboundOptions(externalStorage));

  t.deepEqual(task.start!.input![0], input);
});

test('nexus task completion store offloads the sync result payload', async (t) => {
  const { externalStorage } = externalStorageWith();
  const completion: coresdk.nexus.INexusTaskCompletion = {
    completed: { startOperation: { syncSuccess: { payload: makePayload(256) } } },
  };

  await visit(completion, walkNexusTaskCompletion, extstoreStoreOptions(externalStorage));

  t.true(isReferencePayload(completion.completed!.startOperation!.syncSuccess!.payload!));
});

test('nexus task retrieve resolves the request payload', async (t) => {
  const { externalStorage } = externalStorageWith();
  const requestPayload = makePayload(256, 5);
  const task: coresdk.nexus.INexusTask = {
    task: { request: { startOperation: { payload: await toReference(externalStorage, requestPayload) } } },
  };

  await visit(task, walkNexusTask, extstoreInboundOptions(externalStorage));

  t.deepEqual(task.task!.request!.startOperation!.payload, requestPayload);
});

test('client request store offloads the workflow input (via generic visit)', async (t) => {
  const { externalStorage } = externalStorageWith();
  const request: temporal.api.workflowservice.v1.IStartWorkflowExecutionRequest = {
    workflowId: 'wf-1',
    input: { payloads: [makePayload(256)] },
  };

  await visit(
    request,
    walkStartWorkflowExecutionRequest,
    extstoreStoreOptions(externalStorage, { initialTarget: WORKFLOW_TARGET })
  );

  t.true(isReferencePayload(request.input!.payloads![0]!));
});

test('client response retrieve resolves the query result (via generic visit)', async (t) => {
  const { externalStorage } = externalStorageWith();
  const queryResult = makePayload(256, 9);
  const response: temporal.api.workflowservice.v1.IQueryWorkflowResponse = {
    queryResult: { payloads: [await toReference(externalStorage, queryResult)] },
  };

  await visit(response, walkQueryWorkflowResponse, extstoreInboundOptions(externalStorage));

  t.deepEqual(response.queryResult!.payloads![0], queryResult);
});

test('inbound options raise TMPRL1105 on a reference when storage is not configured', async (t) => {
  const { externalStorage } = externalStorageWith();
  const task: coresdk.activity_task.IActivityTask = {
    start: { input: [await toReference(externalStorage, makePayload(256, 3))] },
  };

  const err = await t.throwsAsync(() => visit(task, walkActivityTask, extstoreInboundOptions(undefined)), {
    instanceOf: ExternalStorageNotConfiguredError,
  });
  t.regex(err!.message, /TMPRL1105/);
});

test('inbound options leave a reference-free message untouched when storage is not configured', async (t) => {
  const input = makePayload(256, 3);
  const task: coresdk.activity_task.IActivityTask = { start: { input: [input] } };

  await t.notThrowsAsync(() => visit(task, walkActivityTask, extstoreInboundOptions(undefined)));
  t.deepEqual(task.start!.input![0], input, 'payload passes through unchanged');
});

/**
 * Wraps the in-memory fake driver so every call overlaps with any sibling the walk let through,
 * and records the highest number that were ever in flight at once.
 */
function gatedDriver(): { driver: StorageDriver; peakConcurrency: () => number } {
  const inner = makeFakeDriver({ name: 'mem' });
  let inFlight = 0;
  let peak = 0;
  const gate = async <T>(op: () => Promise<T>): Promise<T> => {
    peak = Math.max(peak, ++inFlight);
    try {
      // Hold the call open long enough for every sibling the limit permits to enter before any exits.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await op();
    } finally {
      inFlight--;
    }
  };
  return {
    driver: {
      name: inner.name,
      type: inner.type,
      store: (context, payloads) => gate(() => inner.store(context, payloads)),
      retrieve: (context, claims) => gate(() => inner.retrieve(context, claims)),
    },
    peakConcurrency: () => peak,
  };
}

/** A completion scheduling `count` activities, each carrying one above-threshold argument. */
function completionSchedulingActivities(count: number): coresdk.workflow_completion.IWorkflowActivationCompletion {
  return {
    successful: {
      commands: Array.from({ length: count }, (_, i) => ({
        scheduleActivity: { activityId: `act-${i}`, arguments: [makePayload(256, i)] },
      })),
    },
  };
}

/** External storage over a {@link gatedDriver}, offloading everything above 96 bytes. */
function gatedExternalStorage(maxConcurrentVisits?: number) {
  const { driver, peakConcurrency } = gatedDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 96, maxConcurrentVisits });
  return { externalStorage, peakConcurrency };
}

test('store walk bounds concurrent driver calls to maxConcurrentVisits', async (t) => {
  const { externalStorage, peakConcurrency } = gatedExternalStorage(2);
  const completion = completionSchedulingActivities(6);

  await visit(
    completion,
    walkWorkflowActivationCompletion,
    extstoreStoreOptions(externalStorage, { initialTarget: WORKFLOW_TARGET })
  );

  t.is(peakConcurrency(), 2);
  for (const command of completion.successful!.commands!) {
    t.true(isReferencePayload(command.scheduleActivity!.arguments![0]!));
  }
});

test('store walk runs one driver call at a time at maxConcurrentVisits = 1', async (t) => {
  const { externalStorage, peakConcurrency } = gatedExternalStorage(1);

  await visit(
    completionSchedulingActivities(4),
    walkWorkflowActivationCompletion,
    extstoreStoreOptions(externalStorage, { initialTarget: WORKFLOW_TARGET })
  );

  t.is(peakConcurrency(), 1);
});

test('store walk defaults to 3 concurrent driver calls', async (t) => {
  const { externalStorage, peakConcurrency } = gatedExternalStorage();

  await visit(
    completionSchedulingActivities(6),
    walkWorkflowActivationCompletion,
    extstoreStoreOptions(externalStorage, { initialTarget: WORKFLOW_TARGET })
  );

  t.is(peakConcurrency(), 3);
});

test('inbound walk bounds concurrent driver calls to maxConcurrentVisits', async (t) => {
  const { externalStorage, peakConcurrency } = gatedExternalStorage(2);
  const originals = Array.from({ length: 6 }, (_, i) => makePayload(256, i));
  const jobs: coresdk.workflow_activation.IWorkflowActivationJob[] = [];
  for (const original of originals) {
    // Awaited one at a time, so the setup itself never exceeds a concurrency of 1.
    jobs.push({ resolveActivity: { result: { completed: { result: await toReference(externalStorage, original) } } } });
  }
  const activation: coresdk.workflow_activation.IWorkflowActivation = { jobs };

  await visit(activation, walkWorkflowActivation, extstoreInboundOptions(externalStorage));

  t.is(peakConcurrency(), 2);
  t.deepEqual(
    activation.jobs!.map((job) => job.resolveActivity!.result!.completed!.result!),
    originals
  );
});
