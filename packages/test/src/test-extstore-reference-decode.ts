/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import type { Payload, PayloadCodec, SerializationContext } from '@temporalio/common';
import {
  ExternalStorage,
  ExternalStorageNotConfiguredError,
  ExternalStorageReferenceError,
  METADATA_ENCODING_KEY,
} from '@temporalio/common';
import {
  ExternalStorageRunner,
  externalStorageReferenceDecodeVisitOptions,
  externalStorageRetrieveVisitOptions,
  hasReferenceMarker,
  InMemoryPayloadCache,
  isReferencePayload,
  visit,
  walkActivityTask,
  walkWorkflowActivation,
} from '@temporalio/common/internal/internal-non-workflow';
import { decode, encode } from '@temporalio/common/encoding';
import { temporal } from '@temporalio/proto';
import type { coresdk } from '@temporalio/proto';
import { WorkflowCodecRunner } from '@temporalio/worker/internal';
import { makeFakeDriver, type FakeDriver } from './extstore-fake-driver';

const MARKER_KEY = '__temporal_external_storage_reference';
const RECORDED_ENCODING = 'binary/recorded';

/**
 * Wraps each payload in a new payload, and records the input and context of each decode of a
 * payload it wrapped.
 */
class RecordingCodec implements PayloadCodec {
  readonly decodedInputs: Payload[] = [];
  readonly decodedContexts: (SerializationContext | undefined)[] = [];

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => ({
      metadata: { [METADATA_ENCODING_KEY]: encode(RECORDED_ENCODING) },
      data: temporal.api.common.v1.Payload.encode(payload).finish(),
    }));
  }

  async decode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.[METADATA_ENCODING_KEY];
      if (encoding == null || decode(encoding) !== RECORDED_ENCODING) return payload;
      this.decodedInputs.push(payload);
      this.decodedContexts.push(context);
      const message = temporal.api.common.v1.Payload.decode(payload.data!);
      const decoded: Payload = {
        metadata: Object.fromEntries(Object.entries(message.metadata).map(([k, v]) => [k, new Uint8Array(v)])),
        data: new Uint8Array(message.data),
      };
      if (message.externalPayloads.length > 0) decoded.externalPayloads = message.externalPayloads;
      return decoded;
    });
  }
}

function makePayload(bodyBytes: number, fill = 0): Payload {
  return {
    metadata: { [METADATA_ENCODING_KEY]: encode('binary/plain') },
    data: new Uint8Array(bodyBytes).fill(fill),
  };
}

function makeExternalStorage(driver: FakeDriver = makeFakeDriver({ name: 's3' })): ExternalStorage {
  return new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 96 });
}

async function toReference(externalStorage: ExternalStorage, payload: Payload): Promise<Payload> {
  const [reference] = await new ExternalStorageRunner(externalStorage, { payloadCache: false }).store([payload]);
  return reference!;
}

/** Encodes a reference with codec and marks it, as an SDK that writes encoded references does. */
async function toEncodedReference(codec: PayloadCodec, reference: Payload): Promise<Payload> {
  const [encoded] = await codec.encode([reference]);
  return {
    ...encoded,
    metadata: { ...encoded!.metadata, [MARKER_KEY]: encode('true') },
    externalPayloads: reference.externalPayloads,
  };
}

function retrieveOptions(externalStorage: ExternalStorage) {
  return externalStorageRetrieveVisitOptions({ externalStorage, payloadCache: false });
}

const workflowContext: SerializationContext = { type: 'workflow', namespace: 'ns', workflowId: 'wf-1' };
const activityContext: SerializationContext = {
  type: 'activity',
  namespace: 'ns',
  workflowId: 'wf-1',
  activityId: 'act-1',
  isLocal: false,
};
const nexusContext: SerializationContext = {
  type: 'nexus',
  endpoint: 'my-endpoint',
  service: 'my-service',
  operation: 'my-operation',
};

const contextSet = (contexts: (SerializationContext | undefined)[]) => contexts.map((c) => JSON.stringify(c)).sort();

test('an encoded reference is decoded with its context, then retrieved', async (t) => {
  const externalStorage = makeExternalStorage();
  const codec = new RecordingCodec();
  const input = makePayload(256, 3);
  const task: coresdk.activity_task.IActivityTask = {
    start: { input: [await toEncodedReference(codec, await toReference(externalStorage, input))] },
  };

  await visit(
    task,
    walkActivityTask,
    externalStorageReferenceDecodeVisitOptions({ externalStorage, codecs: [codec], initialContext: activityContext })
  );
  await visit(task, walkActivityTask, retrieveOptions(externalStorage));

  t.deepEqual(task.start!.input![0], input);
  t.deepEqual(codec.decodedContexts, [activityContext]);
});

test('the codec decodes the reference as it appears in history', async (t) => {
  const externalStorage = makeExternalStorage();
  const codec = new RecordingCodec();
  const encoded = await toEncodedReference(codec, await toReference(externalStorage, makePayload(256, 3)));
  const task: coresdk.activity_task.IActivityTask = { start: { input: [encoded] } };

  await visit(task, walkActivityTask, externalStorageReferenceDecodeVisitOptions({ externalStorage, codecs: [codec] }));

  t.true(hasReferenceMarker(codec.decodedInputs[0]!), 'marker is not stripped');
  t.deepEqual(codec.decodedInputs[0]!.externalPayloads, encoded.externalPayloads, 'externalPayloads is not stripped');
  t.true(isReferencePayload(task.start!.input![0]!));
});

test('unmarked payloads are not decoded', async (t) => {
  const externalStorage = makeExternalStorage();
  const codec = new RecordingCodec();
  const reference = await toReference(externalStorage, makePayload(256, 3));
  const inline = makePayload(8);
  const task: coresdk.activity_task.IActivityTask = { start: { input: [reference, inline] } };

  await visit(task, walkActivityTask, externalStorageReferenceDecodeVisitOptions({ externalStorage, codecs: [codec] }));

  t.deepEqual(task.start!.input, [reference, inline]);
  t.is(codec.decodedInputs.length, 0);
});

test('a marked reference written with no codec is already the reference', async (t) => {
  const externalStorage = makeExternalStorage();
  const reference = await toReference(externalStorage, makePayload(256, 3));
  const marked = { ...reference, metadata: { ...reference.metadata, [MARKER_KEY]: encode('true') } };
  const task: coresdk.activity_task.IActivityTask = { start: { input: [marked] } };

  await visit(task, walkActivityTask, externalStorageReferenceDecodeVisitOptions({ externalStorage, codecs: [] }));

  t.deepEqual(task.start!.input![0], marked);
});

test('TMPRL1105 is raised before decoding when storage is not configured', async (t) => {
  const codec = new RecordingCodec();
  const encoded = await toEncodedReference(codec, await toReference(makeExternalStorage(), makePayload(256, 3)));
  const task: coresdk.activity_task.IActivityTask = { start: { input: [encoded] } };

  const err = await t.throwsAsync(
    () =>
      visit(
        task,
        walkActivityTask,
        externalStorageReferenceDecodeVisitOptions({ externalStorage: undefined, codecs: [codec] })
      ),
    { instanceOf: ExternalStorageNotConfiguredError }
  );
  t.regex(err!.message, /TMPRL1105/);
  t.is(codec.decodedInputs.length, 0);
});

test('TMPRL1106 is raised when a marked payload does not decode to a reference', async (t) => {
  const externalStorage = makeExternalStorage();
  const encoded = await toEncodedReference(
    new RecordingCodec(),
    await toReference(externalStorage, makePayload(256, 3))
  );
  const task: coresdk.activity_task.IActivityTask = { start: { input: [encoded] } };

  // Read without the codec that wrote the reference.
  const err = await t.throwsAsync(
    () => visit(task, walkActivityTask, externalStorageReferenceDecodeVisitOptions({ externalStorage, codecs: [] })),
    { instanceOf: ExternalStorageReferenceError }
  );
  t.regex(err!.message, /TMPRL1106/);
});

test('externalPayloads is restored when the codec drops it', async (t) => {
  const externalStorage = makeExternalStorage();
  const codec = new RecordingCodec();
  const reference = await toReference(externalStorage, makePayload(256, 3));
  const encoded = await toEncodedReference(codec, { ...reference, externalPayloads: [] });
  const task: coresdk.activity_task.IActivityTask = {
    start: { input: [{ ...encoded, externalPayloads: reference.externalPayloads }] },
  };

  await visit(task, walkActivityTask, externalStorageReferenceDecodeVisitOptions({ externalStorage, codecs: [codec] }));

  t.deepEqual(task.start!.input![0]!.externalPayloads, reference.externalPayloads);
});

test('header references follow the codec header setting', async (t) => {
  const externalStorage = makeExternalStorage();
  const codec = new RecordingCodec();
  const encoded = await toEncodedReference(codec, await toReference(externalStorage, makePayload(256, 3)));

  const skipped: coresdk.activity_task.IActivityTask = { start: { headerFields: { header: encoded } } };
  await visit(
    skipped,
    walkActivityTask,
    externalStorageReferenceDecodeVisitOptions({ externalStorage, codecs: [codec] })
  );
  t.deepEqual(skipped.start!.headerFields!.header, encoded);
  t.is(codec.decodedInputs.length, 0);

  // With header codecs enabled, header references are decoded too.
  const decoded: coresdk.activity_task.IActivityTask = { start: { headerFields: { header: encoded } } };
  await visit(
    decoded,
    walkActivityTask,
    externalStorageReferenceDecodeVisitOptions({ externalStorage, codecs: [codec], skipHeaders: false })
  );
  t.true(isReferencePayload(decoded.start!.headerFields!.header!));
});

test('a decoded reference is retrieved through the payload cache', async (t) => {
  const driver = makeFakeDriver({ name: 's3' });
  const externalStorage = makeExternalStorage(driver);
  const codec = new RecordingCodec();
  const encoded = await toEncodedReference(codec, await toReference(externalStorage, makePayload(256, 3)));
  const payloadCache = new InMemoryPayloadCache({ maxTotalBytes: 1 << 20 });

  for (let i = 0; i < 2; i++) {
    const task: coresdk.activity_task.IActivityTask = { start: { input: [encoded] } };
    await visit(
      task,
      walkActivityTask,
      externalStorageReferenceDecodeVisitOptions({ externalStorage, codecs: [codec] })
    );
    await visit(task, walkActivityTask, externalStorageRetrieveVisitOptions({ externalStorage, payloadCache }));
  }

  // The cache is keyed by the decoded reference, so the second read is served from it.
  t.is(driver.retrieveCalls.length, 1);
});

test('activation references use the activity context, and decodeActivation still gets it', async (t) => {
  const externalStorage = makeExternalStorage();
  const codec = new RecordingCodec();
  const runner = new WorkflowCodecRunner([codec], { type: 'workflow', namespace: 'ns', workflowId: 'wf-1' });
  await runner.encodeCompletion({
    successful: { commands: [{ scheduleActivity: { seq: 1, activityId: 'act-1', arguments: [] } }] },
  });
  const result = makePayload(256, 3);
  const [encodedResult] = await codec.encode([result]);
  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: [
      {
        resolveActivity: {
          seq: 1,
          result: {
            completed: {
              result: await toEncodedReference(codec, await toReference(externalStorage, encodedResult!)),
            },
          },
        },
      },
      {
        signalWorkflow: {
          signalName: 's',
          input: [await toEncodedReference(codec, await toReference(externalStorage, encodedResult!))],
        },
      },
    ],
  };

  await runner.decodeActivationReferences(activation, externalStorage);
  await visit(activation, walkWorkflowActivation, retrieveOptions(externalStorage));
  const decoded = await runner.decodeActivation(activation);

  // The reference decodes, then the regular decodes of the retrieved payloads, each with the same contexts.
  t.deepEqual(contextSet(codec.decodedContexts.slice(0, 2)), contextSet([activityContext, workflowContext]));
  t.deepEqual(contextSet(codec.decodedContexts.slice(2)), contextSet([activityContext, workflowContext]));
  t.deepEqual(decoded.jobs![0]!.resolveActivity!.result!.completed!.result, result);
  t.deepEqual(decoded.jobs![1]!.signalWorkflow!.input![0], result);
});

test('a Nexus operation result reference uses the operation context', async (t) => {
  const externalStorage = makeExternalStorage();
  const codec = new RecordingCodec();
  const runner = new WorkflowCodecRunner([codec], { type: 'workflow', namespace: 'ns', workflowId: 'wf-1' });
  await runner.encodeCompletion({
    successful: {
      commands: [
        {
          scheduleNexusOperation: {
            seq: 2,
            endpoint: 'my-endpoint',
            service: 'my-service',
            operation: 'my-operation',
            input: makePayload(8),
          },
        },
      ],
    },
  });
  const result = makePayload(256, 3);
  const [encodedResult] = await codec.encode([result]);
  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: [
      {
        resolveNexusOperation: {
          seq: 2,
          result: {
            completed: await toEncodedReference(codec, await toReference(externalStorage, encodedResult!)),
          },
        },
      },
    ],
  };

  await runner.decodeActivationReferences(activation, externalStorage);
  await visit(activation, walkWorkflowActivation, retrieveOptions(externalStorage));
  const decoded = await runner.decodeActivation(activation);

  t.deepEqual(codec.decodedContexts, [nexusContext, nexusContext]);
  t.deepEqual(decoded.jobs![0]!.resolveNexusOperation!.result!.completed, result);
});

test("a previous run's outcome reference uses the propagated Nexus context", async (t) => {
  const externalStorage = makeExternalStorage();
  const codec = new RecordingCodec();
  const runner = new WorkflowCodecRunner([codec], { type: 'workflow', namespace: 'ns', workflowId: 'wf-1' });
  const [encodedArgument] = await codec.encode([makePayload(8)]);
  const lastCompletionResult = makePayload(256, 3);
  const [encodedResult] = await codec.encode([lastCompletionResult]);
  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: [
      {
        initializeWorkflow: {
          workflowId: 'wf-1',
          arguments: [encodedArgument!],
          lastCompletionResult: {
            payloads: [await toEncodedReference(codec, await toReference(externalStorage, encodedResult!))],
          },
          propagatedNexusSerializationContext: {
            endpoint: 'my-endpoint',
            service: 'my-service',
            operation: 'my-operation',
          },
        },
      },
    ],
  };

  await runner.decodeActivationReferences(activation, externalStorage);
  t.deepEqual(codec.decodedContexts, [nexusContext]);
  t.truthy(activation.jobs![0]!.initializeWorkflow!.lastCompletionResult, 'the previous run outcome is restored');

  await visit(activation, walkWorkflowActivation, retrieveOptions(externalStorage));
  const decoded = await runner.decodeActivation(activation);
  t.deepEqual(decoded.jobs![0]!.initializeWorkflow!.lastCompletionResult!.payloads![0], lastCompletionResult);
});

test('activation references are decoded with the codec concurrency limit', async (t) => {
  const externalStorage = makeExternalStorage();
  const recording = new RecordingCodec();
  let inFlight = 0;
  let maxInFlight = 0;
  const codec: PayloadCodec = {
    encode: (payloads) => recording.encode(payloads),
    async decode(payloads, context) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return recording.decode(payloads, context);
    },
  };
  const encodedReference = await toEncodedReference(codec, await toReference(externalStorage, makePayload(256)));
  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: Array.from({ length: 30 }, () => ({ signalWorkflow: { signalName: 's', input: [{ ...encodedReference }] } })),
  };
  const runner = new WorkflowCodecRunner([codec], { type: 'workflow', namespace: 'ns', workflowId: 'wf-1' });

  await runner.decodeActivationReferences(activation, externalStorage);

  t.is(recording.decodedInputs.length, 30);
  t.true(maxInFlight > 1);
  t.true(maxInFlight <= 20);
});
