import test from 'ava';
import type { Payload, SerializationContext } from '@temporalio/common';
import { ApplicationFailure, defaultFailureConverter, defaultPayloadConverter } from '@temporalio/common';
import { ProtobufBinaryPayloadConverter } from '@temporalio/common/lib/converter/protobuf-payload-converters';
import * as protoRoot from '@temporalio/proto';
import { WorkflowCodecRunner } from '@temporalio/worker/lib/workflow-codec-runner';
import { FreePayloadCodec, makeContextTrace } from './payload-converters/serialization-context-converter';

const targetContext = { type: 'workflow' as const, namespace: 'target-ns', workflowId: 'target-id' };

function payload(label: string): Payload {
  return defaultPayloadConverter.toPayload(makeContextTrace(label));
}

function systemNexusEnvelope(value: unknown, context?: SerializationContext): Payload {
  const envelope = defaultPayloadConverter.toPayload(value)!;
  envelope.metadata ??= {};
  envelope.metadata.__temporal_system_payload = new Uint8Array([116, 114, 117, 101]);
  if (context != null) envelope.metadata.__temporal_system_context = new TextEncoder().encode(JSON.stringify(context));
  return envelope;
}

function traceFromPayload(payload: Payload | null | undefined): string[] {
  return payload ? defaultPayloadConverter.fromPayload<{ trace: string[] }>(payload).trace : [];
}

function failureWithDetail(label: string) {
  return defaultFailureConverter.errorToFailure(
    ApplicationFailure.nonRetryable('boom', 'TestFailure', makeContextTrace(label)),
    defaultPayloadConverter
  );
}

test('signal-with-start uses the target context for codec encode and decode', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'caller-ns',
    workflowId: 'caller-id',
  });
  const encoded = await runner.encodeCompletion({
    successful: {
      commands: [
        {
          scheduleNexusOperation: {
            seq: 42,
            endpoint: '__temporal_system',
            service: 'temporal.api.workflowservice.v1.WorkflowService',
            operation: 'SignalWithStartWorkflowExecution',
            input: systemNexusEnvelope(
              {
                namespace: 'target-ns',
                workflowId: 'target-id',
                input: { payloads: [payload('workflow-arg')] },
                signalInput: { payloads: [payload('signal-arg')] },
                memo: { fields: { memo: payload('memo') } },
                searchAttributes: { indexedFields: { search: payload('search-attribute') } },
              },
              targetContext
            ),
          },
        },
      ],
    },
  });
  const envelope = encoded.successful?.commands?.[0]?.scheduleNexusOperation?.input;
  t.is(envelope?.metadata?.__temporal_system_context, undefined);
  const request = new ProtobufBinaryPayloadConverter(protoRoot).fromPayload<any>(envelope!);
  t.deepEqual(traceFromPayload(request.input?.payloads?.[0]), [
    'codec.encode.bound|workflow-arg|workflow.target-ns.target-id',
  ]);
  t.deepEqual(traceFromPayload(request.signalInput?.payloads?.[0]), [
    'codec.encode.bound|signal-arg|workflow.target-ns.target-id',
  ]);
  t.deepEqual(traceFromPayload(request.memo?.fields?.memo), ['codec.encode.bound|memo|workflow.target-ns.target-id']);

  await runner.encodeCompletion({
    successful: {
      commands: [
        {
          scheduleNexusOperation: {
            seq: 43,
            endpoint: '__temporal_system',
            service: 'temporal.api.workflowservice.v1.WorkflowService',
            operation: 'SignalWithStartWorkflowExecution',
            input: systemNexusEnvelope({}, targetContext),
          },
        },
      ],
    },
  });
  const failed = failureWithDetail('system-failure');
  failed.applicationFailureInfo!.details!.payloads = await new FreePayloadCodec().encode(
    failed.applicationFailureInfo!.details!.payloads!,
    targetContext
  );
  const decoded = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [{ resolveNexusOperation: { seq: 43, result: { failed } } }],
  });
  t.deepEqual(
    traceFromPayload(
      decoded.jobs?.[0]?.resolveNexusOperation?.result?.failed?.applicationFailureInfo?.details?.payloads?.[0]
    ),
    [
      'codec.encode.bound|system-failure|workflow.target-ns.target-id',
      'codec.decode.bound|system-failure|workflow.target-ns.target-id',
    ]
  );
});

test('signal-with-start rejects malformed serialization context metadata', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'caller-ns',
    workflowId: 'caller-id',
  });
  await t.throwsAsync(
    runner.encodeCompletion({
      successful: {
        commands: [
          {
            scheduleNexusOperation: {
              seq: 42,
              endpoint: '__temporal_system',
              service: 'temporal.api.workflowservice.v1.WorkflowService',
              operation: 'SignalWithStartWorkflowExecution',
              input: systemNexusEnvelope({}, { type: 'workflow', namespace: 'target-ns' } as SerializationContext),
            },
          },
        ],
      },
    }),
    { message: 'invalid System Nexus serialization context metadata' }
  );
});

test('signal-with-start requires serialization context metadata', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'caller-ns',
    workflowId: 'caller-id',
  });
  await t.throwsAsync(
    runner.encodeCompletion({
      successful: {
        commands: [
          {
            scheduleNexusOperation: {
              seq: 42,
              endpoint: '__temporal_system',
              service: 'temporal.api.workflowservice.v1.WorkflowService',
              operation: 'SignalWithStartWorkflowExecution',
              input: systemNexusEnvelope({}),
            },
          },
        ],
      },
    }),
    { message: 'missing System Nexus serialization context metadata' }
  );
});
