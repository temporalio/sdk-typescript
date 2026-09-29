import test from 'ava';
import * as nexus from 'nexus-rpc';
import type { LoadedDataConverter, Payload, PayloadCodec, TypeInfo } from '@temporalio/common';
import { defaultDataConverter, defaultPayloadConverter } from '@temporalio/common';
import { ProtobufBinaryPayloadConverter } from '@temporalio/common/lib/converter/protobuf-payload-converters';
import {
  SYSTEM_NEXUS_PAYLOAD_METADATA_KEY,
  SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE,
} from '@temporalio/common/lib/internal-workflow';
import * as protoRoot from '@temporalio/proto';
import type { temporal } from '@temporalio/proto';
import type { SignalWithStartWorkflowRequest } from '@temporalio/workflow';
import { workflowService } from '@temporalio/workflow/lib/nexus/system/generated/services';
import { decodePayload } from '@temporalio/worker/lib/nexus/conversions';

const protobufPayloadConverter = new ProtobufBinaryPayloadConverter(protoRoot);
const signalWithStartInputType = workflowService.operations.signalWithStartWorkflow.inputType;

function systemNexusPayload(input = 'workflow-input', signalInput?: string): Payload {
  const request = protoRoot.temporal.api.workflowservice.v1.SignalWithStartWorkflowExecutionRequest.create({
    workflowType: { name: 'test-workflow' },
    input: { payloads: [defaultPayloadConverter.toPayload(input)] },
    signalInput: signalInput == null ? undefined : { payloads: [defaultPayloadConverter.toPayload(signalInput)] },
    workflowId: 'target-workflow-id',
    taskQueue: { name: 'target-task-queue' },
    signalName: 'test-signal',
    namespace: 'target-namespace',
  });
  const payload = protobufPayloadConverter.toPayload(request)!;
  payload.metadata ??= {};
  payload.metadata[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY] = SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE;
  return payload;
}

test('Nexus worker decodes a marked System Nexus input with the System Nexus converter', async (t) => {
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

test('Nexus worker applies the operation input transfer type converter to a System Nexus input', async (t) => {
  const result = await decodePayload(defaultDataConverter, systemNexusPayload(), testSystemRequestType);

  t.deepEqual(result, { value: 'target-namespace' });
});

test('Nexus worker rejects an unknown marked System Nexus input before calling codecs', async (t) => {
  for (const withCodec of [false, true]) {
    let decodeCount = 0;
    const codec: PayloadCodec = {
      async encode(payloads) {
        return payloads;
      },
      async decode(payloads) {
        decodeCount++;
        return payloads;
      },
    };
    const dataConverter: LoadedDataConverter = {
      ...defaultDataConverter,
      payloadCodecs: withCodec ? [codec] : [],
    };
    const payload = defaultPayloadConverter.toPayload('ignored');
    payload.metadata ??= {};
    payload.metadata.messageType = new TextEncoder().encode('temporal.api.workflowservice.v1.UnknownRequest');
    payload.metadata[SYSTEM_NEXUS_PAYLOAD_METADATA_KEY] = SYSTEM_NEXUS_PAYLOAD_METADATA_VALUE;

    const err = await t.throwsAsync(() => decodePayload(dataConverter, payload, signalWithStartInputType), {
      instanceOf: nexus.HandlerError,
    });

    t.is(err?.type, 'INTERNAL');
    t.true(err?.retryable);
    t.is(err?.retryableOverride, true);
    t.is(
      err?.message,
      'Unrecognized System Nexus envelope message type: temporal.api.workflowservice.v1.UnknownRequest'
    );
    t.is(decodeCount, 0);
  }
});

test('Nexus worker applies codecs to nested payloads but not the System Nexus envelope', async (t) => {
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

test('Nexus worker applies the configured payload converter to inner System Nexus payloads', async (t) => {
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

test('Nexus worker continues to use the configured converter for an unmarked input', async (t) => {
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
