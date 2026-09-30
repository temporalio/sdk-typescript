import test from 'ava';
import * as nexus from 'nexus-rpc';
import type { LoadedDataConverter, Payload, PayloadCodec, TypeInfo } from '@temporalio/common';
import {
  ApplicationFailure,
  defaultDataConverter,
  defaultPayloadConverter,
  ExternalStorageNotConfiguredError,
  RawValue,
  rawValueTypeInfo,
} from '@temporalio/common';
import { ExternalStorage } from '@temporalio/common/lib/converter/extstore';
import {
  ExternalStorageRunner,
  extstoreInboundOptions,
  isReferencePayload,
} from '@temporalio/common/lib/internal-non-workflow';
import { ProtobufBinaryPayloadConverter } from '@temporalio/common/lib/converter/protobuf-payload-converters';
import {
  SYSTEM_NEXUS_PAYLOAD_METADATA_KEY,
  SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE,
} from '@temporalio/common/lib/internal-workflow';
import * as protoRoot from '@temporalio/proto';
import type { coresdk, temporal } from '@temporalio/proto';
import type { SignalWithStartWorkflowRequest } from '@temporalio/workflow';
import { workflowService } from '@temporalio/workflow/lib/nexus/system/generated/services';
import { decodePayload, PAYLOAD_VALIDATION_ERROR_TYPE } from '@temporalio/worker/lib/nexus/conversions';
import { visitNexusTask } from '@temporalio/worker/lib/system-nexus-operations';
import { makeFakeDriver } from './extstore-fake-driver';

const protobufPayloadConverter = new ProtobufBinaryPayloadConverter(protoRoot);
const signalWithStartInputType = workflowService.operations.signalWithStartWorkflow.inputType;

function systemNexusPayload(input = 'workflow-input', signalInput?: string): Payload {
  return systemNexusPayloadWith(
    defaultPayloadConverter.toPayload(input),
    signalInput == null ? undefined : defaultPayloadConverter.toPayload(signalInput)
  );
}

function systemNexusPayloadWith(
  input: Payload,
  signalInput?: Payload,
  overrides: temporal.api.workflowservice.v1.ISignalWithStartWorkflowExecutionRequest = {}
): Payload {
  const request = protoRoot.temporal.api.workflowservice.v1.SignalWithStartWorkflowExecutionRequest.create({
    workflowType: { name: 'test-workflow' },
    input: { payloads: [input] },
    signalInput: signalInput == null ? undefined : { payloads: [signalInput] },
    workflowId: 'target-workflow-id',
    taskQueue: { name: 'target-task-queue' },
    signalName: 'test-signal',
    namespace: 'target-namespace',
    ...overrides,
  });
  const payload = protobufPayloadConverter.toPayload(request)!;
  payload.metadata ??= {};
  payload.metadata[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY] = SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE;
  return payload;
}

function unknownSystemNexusPayload(): Payload {
  const payload = defaultPayloadConverter.toPayload('ignored');
  payload.metadata ??= {};
  payload.metadata.messageType = new TextEncoder().encode('temporal.api.workflowservice.v1.UnknownRequest');
  payload.metadata[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY] = SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE;
  return payload;
}

function corruptSystemNexusPayload(): Payload {
  return { ...systemNexusPayload(), data: new Uint8Array([0xff, 0xff, 0xff]) };
}

interface CountingCodec extends PayloadCodec {
  decodeCount: number;
}

function countingCodec(): CountingCodec {
  const codec: CountingCodec = {
    decodeCount: 0,
    async encode(payloads) {
      return payloads;
    },
    async decode(payloads) {
      codec.decodeCount++;
      return payloads;
    },
  };
  return codec;
}

/** Codec that shifts every data byte, so a payload decodes correctly only if the codec ran exactly once. */
const shiftingCodec: PayloadCodec = {
  async encode(payloads) {
    return payloads.map((payload) => ({ ...payload, data: payload.data?.map((byte) => byte + 1) }));
  },
  async decode(payloads) {
    return payloads.map((payload) => ({ ...payload, data: payload.data?.map((byte) => byte - 1) }));
  },
};

test('decodePayload uses the System Nexus converter for a marked input', async (t) => {
  const result = (await decodePayload(
    defaultDataConverter,
    systemNexusPayload(),
    signalWithStartInputType
  )) as SignalWithStartWorkflowRequest;

  t.is(result.workflow, 'test-workflow');
  t.deepEqual(result.args, ['workflow-input']);
  t.is(result.id, 'target-workflow-id');
  t.is(result.taskQueue, 'target-task-queue');
  t.is(result.signal, 'test-signal');
  t.is(result.namespace, 'target-namespace');
});

interface TestSystemRequest {
  value: string;
}

const testSystemRequestType: TypeInfo<
  TestSystemRequest,
  temporal.api.workflowservice.v1.ISignalWithStartWorkflowExecutionRequest
> = {
  transferTypeConverter: {
    toTransferType(value) {
      return { namespace: value.value };
    },
    fromTransferType(value) {
      return { value: value.namespace! };
    },
  },
};

test('decodePayload applies the input transfer type converter to a System Nexus input', async (t) => {
  const result = await decodePayload(defaultDataConverter, systemNexusPayload(), testSystemRequestType);

  t.deepEqual(result, { value: 'target-namespace' });
});

test('decodePayload rejects an unknown marked System Nexus input before calling codecs', async (t) => {
  for (const withCodec of [false, true]) {
    const codec = countingCodec();
    const dataConverter: LoadedDataConverter = {
      ...defaultDataConverter,
      payloadCodecs: withCodec ? [codec] : [],
    };

    const err = await t.throwsAsync(
      () => decodePayload(dataConverter, unknownSystemNexusPayload(), signalWithStartInputType),
      { instanceOf: nexus.HandlerError }
    );

    t.is(err?.type, 'INTERNAL', `withCodec=${withCodec}`);
    t.true(err?.retryable, `withCodec=${withCodec}`);
    t.is(err?.retryableOverride, true, `withCodec=${withCodec}`);
    t.is(
      err?.message,
      'Unrecognized System Nexus envelope message type: temporal.api.workflowservice.v1.UnknownRequest',
      `withCodec=${withCodec}`
    );
    t.is(codec.decodeCount, 0, `withCodec=${withCodec}`);
  }
});

test('decodePayload rejects a corrupt System Nexus request as BAD_REQUEST with or without codecs', async (t) => {
  for (const withCodec of [false, true]) {
    const codec = countingCodec();

    const err = await t.throwsAsync(
      () =>
        decodePayload(
          { ...defaultDataConverter, payloadCodecs: withCodec ? [codec] : [] },
          corruptSystemNexusPayload(),
          signalWithStartInputType
        ),
      { instanceOf: nexus.HandlerError }
    );

    t.is(err?.type, 'BAD_REQUEST', `withCodec=${withCodec}`);
    t.false(err?.retryable, `withCodec=${withCodec}`);
    t.is(err?.message, 'Invalid System Nexus request', `withCodec=${withCodec}`);
    t.is(codec.decodeCount, 0, `withCodec=${withCodec}`);
  }
});

test('decodePayload reports a nested codec failure as INTERNAL', async (t) => {
  const codec: PayloadCodec = {
    async encode(payloads) {
      return payloads;
    },
    async decode() {
      throw new Error('codec failed');
    },
  };

  const err = await t.throwsAsync(
    () =>
      decodePayload(
        { ...defaultDataConverter, payloadCodecs: [codec] },
        systemNexusPayload(),
        signalWithStartInputType
      ),
    { instanceOf: nexus.HandlerError }
  );

  t.is(err?.type, 'INTERNAL');
  t.is(err?.message, 'Payload codec failed to decode Nexus operation input');
});

test('decodePayload reports a nested payload validation failure as BAD_REQUEST', async (t) => {
  const codec: PayloadCodec = {
    async encode(payloads) {
      return payloads;
    },
    async decode() {
      throw ApplicationFailure.nonRetryable('invalid nested payload', PAYLOAD_VALIDATION_ERROR_TYPE);
    },
  };

  const err = await t.throwsAsync(
    () =>
      decodePayload(
        { ...defaultDataConverter, payloadCodecs: [codec] },
        systemNexusPayload(),
        signalWithStartInputType
      ),
    { instanceOf: nexus.HandlerError }
  );

  t.is(err?.type, 'BAD_REQUEST');
  t.is(err?.message, 'Invalid operation input');
});

test('decodePayload reports a System Nexus request missing a required field as BAD_REQUEST', async (t) => {
  const err = await t.throwsAsync(
    () =>
      decodePayload(
        defaultDataConverter,
        systemNexusPayloadWith(defaultPayloadConverter.toPayload('workflow-input'), undefined, { workflowId: '' }),
        signalWithStartInputType
      ),
    { instanceOf: nexus.HandlerError }
  );

  t.is(err?.type, 'BAD_REQUEST');
  t.false(err?.retryable);
  t.is(err?.message, 'Payload converter failed to decode Nexus operation input');
});

test('decodePayload passes empty nested payload data to the converter', async (t) => {
  const result = (await decodePayload(
    defaultDataConverter,
    systemNexusPayloadWith(
      defaultPayloadConverter.toPayload(new Uint8Array()),
      defaultPayloadConverter.toPayload(new Uint8Array())
    ),
    signalWithStartInputType
  )) as SignalWithStartWorkflowRequest;

  const values = [...(result.args ?? []), ...(result.signalArgs ?? [])];
  t.is(values.length, 2);
  for (const value of values) {
    t.true(value instanceof Uint8Array);
    t.is((value as Uint8Array).length, 0);
  }
});

test('decodePayload keeps the System Nexus marker on a RawValue input after codecs run', async (t) => {
  const codec: PayloadCodec = {
    async encode(payloads) {
      return payloads;
    },
    async decode() {
      return [defaultPayloadConverter.toPayload('decoded-input')];
    },
  };

  const result = await decodePayload(
    { ...defaultDataConverter, payloadCodecs: [codec] },
    systemNexusPayload(),
    rawValueTypeInfo
  );

  t.true(result instanceof RawValue);
  const payload = (result as RawValue).payload;
  t.deepEqual(payload.metadata?.[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY], SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE);
  t.deepEqual(
    nestedPayloads(payload).input.map((nested) => defaultPayloadConverter.fromPayload(nested)),
    ['decoded-input']
  );
});

test('decodePayload applies codecs to nested payloads but not the System Nexus envelope', async (t) => {
  let decodeCount = 0;
  let encodeCount = 0;
  const codec: PayloadCodec = {
    async encode(payloads) {
      encodeCount++;
      return payloads;
    },
    async decode(payloads) {
      t.true(payloads.every((payload) => payload.metadata?.[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY] == null));
      decodeCount++;
      return [defaultPayloadConverter.toPayload('decoded-input')];
    },
  };

  const result = (await decodePayload(
    { ...defaultDataConverter, payloadCodecs: [codec] },
    systemNexusPayload(),
    signalWithStartInputType
  )) as SignalWithStartWorkflowRequest;

  t.is(decodeCount, 1);
  t.is(encodeCount, 0);
  t.deepEqual(result.args, ['decoded-input']);
});

test('decodePayload applies the configured converter to nested System Nexus payloads', async (t) => {
  const decoded: string[] = [];
  const dataConverter: LoadedDataConverter = {
    ...defaultDataConverter,
    payloadConverter: {
      toPayload(value) {
        return defaultPayloadConverter.toPayload(value);
      },
      fromPayload<T>(payload: Payload) {
        t.is(payload.metadata?.[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY], undefined);
        const value = defaultPayloadConverter.fromPayload<string>(payload);
        decoded.push(value);
        return `converted-${value}` as T;
      },
    },
  };

  const result = (await decodePayload(
    dataConverter,
    systemNexusPayload('workflow-input', 'signal-input'),
    signalWithStartInputType
  )) as SignalWithStartWorkflowRequest;

  t.deepEqual(result.args, ['converted-workflow-input']);
  t.deepEqual(result.signalArgs, ['converted-signal-input']);
  t.deepEqual(decoded, ['workflow-input', 'signal-input']);
});

test('decodePayload uses the configured converter for an unmarked input', async (t) => {
  let fromPayloadCount = 0;
  const dataConverter: LoadedDataConverter = {
    ...defaultDataConverter,
    payloadConverter: {
      toPayload(value) {
        return defaultPayloadConverter.toPayload(value);
      },
      fromPayload(payload) {
        fromPayloadCount++;
        return defaultPayloadConverter.fromPayload(payload);
      },
    },
  };
  const payload = defaultPayloadConverter.toPayload('ordinary-input');

  const result = await decodePayload(dataConverter, payload);

  t.is(result, 'ordinary-input');
  t.is(fromPayloadCount, 1);
});

function nexusStartTask(payload: Payload): coresdk.nexus.INexusTask {
  return { task: { request: { startOperation: { payload } } } };
}

function nestedPayloads(envelope: Payload): { input: Payload[]; signalInput: Payload[] } {
  const request =
    protobufPayloadConverter.fromPayload<temporal.api.workflowservice.v1.ISignalWithStartWorkflowExecutionRequest>(
      envelope
    );
  return {
    input: (request.input?.payloads ?? []) as Payload[],
    signalInput: (request.signalInput?.payloads ?? []) as Payload[],
  };
}

test('visitNexusTask resolves External Storage references nested in a System Nexus input', async (t) => {
  const driver = makeFakeDriver();
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 0 });
  const runner = new ExternalStorageRunner(externalStorage);
  const [inputReference, signalReference] = await runner.store([
    defaultPayloadConverter.toPayload('workflow-input'),
    defaultPayloadConverter.toPayload('signal-input'),
  ]);
  const task = nexusStartTask(systemNexusPayloadWith(inputReference!, signalReference!));

  await visitNexusTask(task, extstoreInboundOptions(externalStorage));

  const envelope = task.task!.request!.startOperation!.payload as Payload;
  t.deepEqual(envelope.metadata?.[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY], SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE);
  const nested = nestedPayloads(envelope);
  t.false([...nested.input, ...nested.signalInput].some(isReferencePayload));
  const result = (await decodePayload(
    defaultDataConverter,
    envelope,
    signalWithStartInputType
  )) as SignalWithStartWorkflowRequest;
  t.deepEqual(result.args, ['workflow-input']);
  t.deepEqual(result.signalArgs, ['signal-input']);
});

test('visitNexusTask rejects a nested reference when External Storage is not configured', async (t) => {
  const externalStorage = new ExternalStorage({ drivers: [makeFakeDriver()], payloadSizeThreshold: 0 });
  const [reference] = await new ExternalStorageRunner(externalStorage).store([
    defaultPayloadConverter.toPayload('workflow-input'),
  ]);
  const task = nexusStartTask(systemNexusPayloadWith(reference!));

  await t.throwsAsync(() => visitNexusTask(task, extstoreInboundOptions(undefined)), {
    instanceOf: ExternalStorageNotConfiguredError,
  });
});

test('visitNexusTask leaves an unrecognized or corrupt marked input for decodePayload to reject', async (t) => {
  for (const [name, payload] of [
    ['unrecognized', unknownSystemNexusPayload()],
    ['corrupt', corruptSystemNexusPayload()],
  ] as const) {
    const task = nexusStartTask(payload);

    await visitNexusTask(task, extstoreInboundOptions(undefined));

    t.is(task.task!.request!.startOperation!.payload, payload, name);
  }
});

test('visitNexusTask retrieves nested references before codecs decode them', async (t) => {
  const externalStorage = new ExternalStorage({ drivers: [makeFakeDriver()], payloadSizeThreshold: 0 });
  const encoded = await shiftingCodec.encode([
    defaultPayloadConverter.toPayload('workflow-input'),
    defaultPayloadConverter.toPayload('signal-input'),
  ]);
  const [inputReference, signalReference] = await new ExternalStorageRunner(externalStorage).store(encoded);
  const task = nexusStartTask(systemNexusPayloadWith(inputReference!, signalReference!));

  await visitNexusTask(task, extstoreInboundOptions(externalStorage));
  const result = (await decodePayload(
    { ...defaultDataConverter, payloadCodecs: [shiftingCodec] },
    task.task!.request!.startOperation!.payload as Payload,
    signalWithStartInputType
  )) as SignalWithStartWorkflowRequest;

  t.deepEqual(result.args, ['workflow-input']);
  t.deepEqual(result.signalArgs, ['signal-input']);
});
