import test from 'ava';
import type { Payload, PayloadCodec } from '@temporalio/common';
import { ApplicationFailure, defaultFailureConverter, defaultPayloadConverter } from '@temporalio/common';
import { ProtobufBinaryPayloadConverter } from '@temporalio/common/lib/converter/protobuf-payload-converters';
import * as protoRoot from '@temporalio/proto';
import { coresdk } from '@temporalio/proto';
import type { temporal } from '@temporalio/proto';
import { WorkflowCodecRunner } from '@temporalio/worker/lib/workflow-codec-runner';
import { FreePayloadCodec, makeContextTrace } from './payload-converters/serialization-context-converter';

function payload(label: string): Payload {
  return defaultPayloadConverter.toPayload(makeContextTrace(label));
}

function systemNexusEnvelope(value: unknown): Payload {
  const envelope = defaultPayloadConverter.toPayload(value)!;
  envelope.metadata ??= {};
  envelope.metadata.__temporal_system_payload = new Uint8Array([116, 114, 117, 101]); // "true"
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

function decodeCompletion(
  completion: coresdk.workflow_completion.IWorkflowActivationCompletion
): coresdk.workflow_completion.WorkflowActivationCompletion {
  const bytes = coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited(completion).finish();
  return coresdk.workflow_completion.WorkflowActivationCompletion.decodeDelimited(bytes);
}

test('decodeActivation binds workflow codec context for initializeWorkflow payloads', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  const activation = {
    runId: 'run-1',
    jobs: [
      {
        initializeWorkflow: {
          workflowId: 'wf-1',
          workflowType: 'test',
          randomnessSeed: { toBytes: () => new Uint8Array([1]) } as any,
          firstExecutionRunId: 'run-1',
          attempt: 1,
          startTime: {} as any,
          arguments: [payload('wf-input')],
        },
      },
    ],
  };
  const decoded = await runner.decodeActivation(activation);

  t.deepEqual(traceFromPayload(decoded.jobs?.[0]?.initializeWorkflow?.arguments?.[0] as Payload), [
    'codec.decode.bound|wf-input|workflow.default.wf-1',
  ]);
  t.deepEqual(traceFromPayload(activation.jobs[0]?.initializeWorkflow?.arguments?.[0] as Payload), []);
});

test('decodeActivation covers every initializeWorkflow payload field but headers and search attributes', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  const decoded = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [
      {
        initializeWorkflow: {
          workflowId: 'wf-1',
          workflowType: 'test',
          randomnessSeed: { toBytes: () => new Uint8Array([1]) } as any,
          firstExecutionRunId: 'run-1',
          attempt: 1,
          startTime: {} as any,
          headers: { 'header-key': payload('header') },
          continuedFailure: failureWithDetail('continued-failure'),
          memo: { fields: { 'memo-key': payload('memo') } },
          lastCompletionResult: { payloads: [payload('last-completion')] },
          searchAttributes: { indexedFields: { 'attr-key': payload('search-attribute') } },
        },
      },
    ],
  });

  const initializeWorkflow = decoded.jobs?.[0]?.initializeWorkflow;
  t.deepEqual(
    traceFromPayload(initializeWorkflow?.continuedFailure?.applicationFailureInfo?.details?.payloads?.[0] as Payload),
    ['codec.decode.bound|continued-failure|workflow.default.wf-1']
  );
  t.deepEqual(traceFromPayload(initializeWorkflow?.memo?.fields?.['memo-key'] as Payload), [
    'codec.decode.bound|memo|workflow.default.wf-1',
  ]);
  t.deepEqual(traceFromPayload(initializeWorkflow?.lastCompletionResult?.payloads?.[0] as Payload), [
    'codec.decode.bound|last-completion|workflow.default.wf-1',
  ]);
  // Headers and search attributes are converted by the workflow itself, never by the codec.
  t.deepEqual(traceFromPayload(initializeWorkflow?.headers?.['header-key'] as Payload), []);
  t.deepEqual(traceFromPayload(initializeWorkflow?.searchAttributes?.indexedFields?.['attr-key'] as Payload), []);
});

test('decodeActivation decodes query, update, and signal inputs with workflow context', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  const decoded = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [
      { queryWorkflow: { queryId: 'q-1', queryType: 'q', arguments: [payload('query-input')] } },
      { doUpdate: { id: 'u-1', name: 'u', input: [payload('update-input')] } },
      { signalWorkflow: { signalName: 's', input: [payload('signal-input')] } },
    ],
  });

  t.deepEqual(traceFromPayload(decoded.jobs?.[0]?.queryWorkflow?.arguments?.[0] as Payload), [
    'codec.decode.bound|query-input|workflow.default.wf-1',
  ]);
  t.deepEqual(traceFromPayload(decoded.jobs?.[1]?.doUpdate?.input?.[0] as Payload), [
    'codec.decode.bound|update-input|workflow.default.wf-1',
  ]);
  t.deepEqual(traceFromPayload(decoded.jobs?.[2]?.signalWorkflow?.input?.[0] as Payload), [
    'codec.decode.bound|signal-input|workflow.default.wf-1',
  ]);
});

test('decodeActivation decodes resolveNexusOperationStart failures', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  const decoded = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [
      {
        resolveNexusOperationStart: {
          seq: 8,
          failed: failureWithDetail('nexus-start-failure'),
        },
      },
    ],
  });

  t.deepEqual(
    traceFromPayload(
      decoded.jobs?.[0]?.resolveNexusOperationStart?.failed?.applicationFailureInfo?.details?.payloads?.[0] as Payload
    ),
    ['codec.decode.bound|nexus-start-failure|workflow.default.wf-1']
  );
});

test('encodeCompletion stores activity context and decodeActivation reuses it for resolveActivity', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  const encoded = decodeCompletion(
    await runner.encodeCompletion({
      successful: {
        commands: [
          {
            scheduleActivity: {
              seq: 1,
              activityId: 'act-1',
              arguments: [payload('activity-input')],
            },
          },
        ],
      },
    })
  );

  t.deepEqual(traceFromPayload(encoded.successful?.commands?.[0]?.scheduleActivity?.arguments?.[0] as Payload), [
    'codec.encode.bound|activity-input|activity.default.wf-1.act-1.false',
  ]);

  const decoded = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [
      {
        resolveActivity: {
          seq: 1,
          result: {
            completed: {
              result: payload('activity-output'),
            },
          },
        },
      },
    ],
  });

  t.deepEqual(traceFromPayload(decoded.jobs?.[0]?.resolveActivity?.result?.completed?.result as Payload), [
    'codec.decode.bound|activity-output|activity.default.wf-1.act-1.false',
  ]);
});

test('encodeCompletion encodes event group marker labels with the command context', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  const encoded = decodeCompletion(
    await runner.encodeCompletion({
      successful: {
        commands: [
          {
            scheduleActivity: {
              seq: 1,
              activityId: 'act-1',
              arguments: [payload('activity-input')],
            },
            eventGroupMarkers: [{ label: { id: 'group-1', label: payload('activity-marker') } }],
          },
          {
            completeWorkflowExecution: {},
            eventGroupMarkers: [{ label: { id: 'group-2', label: payload('workflow-marker') } }],
          },
        ],
      },
    })
  );

  const commands = encoded.successful?.commands ?? [];
  t.deepEqual(traceFromPayload(commands[0]?.eventGroupMarkers?.[0]?.label?.label as Payload), [
    'codec.encode.bound|activity-marker|activity.default.wf-1.act-1.false',
  ]);
  // A command that targets nothing of its own leaves its markers on the workflow context.
  t.deepEqual(traceFromPayload(commands[1]?.eventGroupMarkers?.[0]?.label?.label as Payload), [
    'codec.encode.bound|workflow-marker|workflow.default.wf-1',
  ]);
});

test('encodeCompletion keeps distinct child-workflow contexts for start and completion', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  await runner.encodeCompletion({
    successful: {
      commands: [
        {
          startChildWorkflowExecution: {
            seq: 2,
            workflowId: 'child-1',
            input: [payload('child-input')],
          },
        },
      ],
    },
  });

  const cancelledStart = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [
      {
        resolveChildWorkflowExecutionStart: {
          seq: 2,
          cancelled: {
            failure: failureWithDetail('child-start-failure'),
          },
        },
      },
    ],
  });

  t.deepEqual(
    traceFromPayload(
      cancelledStart.jobs?.[0]?.resolveChildWorkflowExecutionStart?.cancelled?.failure?.applicationFailureInfo?.details
        ?.payloads?.[0] as Payload
    ),
    ['codec.decode.bound|child-start-failure|workflow.default.child-1']
  );

  await runner.encodeCompletion({
    successful: {
      commands: [
        {
          startChildWorkflowExecution: {
            seq: 3,
            workflowId: 'child-2',
            input: [payload('child-input-2')],
          },
        },
      ],
    },
  });

  const completedChild = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [
      {
        resolveChildWorkflowExecution: {
          seq: 3,
          result: {
            completed: {
              result: payload('child-output'),
            },
          },
        },
      },
    ],
  });

  t.deepEqual(
    traceFromPayload(completedChild.jobs?.[0]?.resolveChildWorkflowExecution?.result?.completed?.result as Payload),
    ['codec.decode.bound|child-output|workflow.default.child-2']
  );
});

test('signal and cancel external workflow paths use target workflow context', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  await runner.encodeCompletion({
    successful: {
      commands: [
        {
          signalExternalWorkflowExecution: {
            seq: 4,
            args: [payload('signal-input')],
            workflowExecution: { workflowId: 'target-wf' },
          },
        },
        {
          requestCancelExternalWorkflowExecution: {
            seq: 5,
            workflowExecution: { workflowId: 'target-wf' },
          },
        },
      ],
    },
  });

  const decodedSignal = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [
      {
        resolveSignalExternalWorkflow: {
          seq: 4,
          failure: failureWithDetail('signal-failure'),
        },
      },
      {
        resolveRequestCancelExternalWorkflow: {
          seq: 5,
          failure: failureWithDetail('cancel-failure'),
        },
      },
    ],
  });

  t.deepEqual(
    traceFromPayload(
      decodedSignal.jobs?.[0]?.resolveSignalExternalWorkflow?.failure?.applicationFailureInfo?.details
        ?.payloads?.[0] as Payload
    ),
    ['codec.decode.bound|signal-failure|workflow.default.target-wf']
  );
  t.deepEqual(
    traceFromPayload(
      decodedSignal.jobs?.[1]?.resolveRequestCancelExternalWorkflow?.failure?.applicationFailureInfo?.details
        ?.payloads?.[0] as Payload
    ),
    ['codec.decode.bound|cancel-failure|workflow.default.target-wf']
  );
});

test('nexus operation paths use workflow context', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  const encoded = decodeCompletion(
    await runner.encodeCompletion({
      successful: {
        commands: [
          {
            scheduleNexusOperation: {
              seq: 6,
              input: payload('nexus-input'),
            },
          },
        ],
      },
    })
  );

  t.deepEqual(traceFromPayload(encoded.successful?.commands?.[0]?.scheduleNexusOperation?.input as Payload), [
    'codec.encode.bound|nexus-input|workflow.default.wf-1',
  ]);

  const decodedCompleted = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [
      {
        resolveNexusOperation: {
          seq: 6,
          result: {
            completed: payload('nexus-output'),
          },
        },
      },
    ],
  });

  t.deepEqual(traceFromPayload(decodedCompleted.jobs?.[0]?.resolveNexusOperation?.result?.completed as Payload), [
    'codec.decode.bound|nexus-output|workflow.default.wf-1',
  ]);

  const decodedFailed = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [
      {
        resolveNexusOperation: {
          seq: 7,
          result: {
            failed: failureWithDetail('nexus-failure'),
          },
        },
      },
    ],
  });

  t.deepEqual(
    traceFromPayload(
      decodedFailed.jobs?.[0]?.resolveNexusOperation?.result?.failed?.applicationFailureInfo?.details
        ?.payloads?.[0] as Payload
    ),
    ['codec.decode.bound|nexus-failure|workflow.default.wf-1']
  );
});

test('runner remains compatible with codecs that ignore context', async (t) => {
  class FreeOnlyCodec implements PayloadCodec {
    async encode(payloads: Payload[]): Promise<Payload[]> {
      return payloads.map((payload) => {
        const value = defaultPayloadConverter.fromPayload<{ label: string; trace: string[] }>(payload);
        value.trace.push(`codec.encode.free|${value.label}`);
        return defaultPayloadConverter.toPayload(value);
      });
    }

    async decode(payloads: Payload[]): Promise<Payload[]> {
      return payloads.map((payload) => {
        const value = defaultPayloadConverter.fromPayload<{ label: string; trace: string[] }>(payload);
        value.trace.push(`codec.decode.free|${value.label}`);
        return defaultPayloadConverter.toPayload(value);
      });
    }
  }

  const runner = new WorkflowCodecRunner([new FreeOnlyCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  const encoded = decodeCompletion(
    await runner.encodeCompletion({
      successful: {
        commands: [
          {
            completeWorkflowExecution: {
              result: payload('wf-output'),
            },
          },
        ],
      },
    })
  );

  t.deepEqual(traceFromPayload(encoded.successful?.commands?.[0]?.completeWorkflowExecution?.result as Payload), [
    'codec.encode.free|wf-output',
  ]);
});

test('system Nexus signal-with-start uses the target workflow serialization context', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'caller-ns',
    workflowId: 'caller-id',
  });
  const encoded = decodeCompletion(
    await runner.encodeCompletion({
      successful: {
        commands: [
          {
            scheduleNexusOperation: {
              seq: 42,
              endpoint: '__temporal_system',
              service: 'temporal.api.workflowservice.v1.WorkflowService',
              operation: 'SignalWithStartWorkflowExecution',
              input: systemNexusEnvelope({
                namespace: 'target-ns',
                workflowId: 'target-id',
                input: { payloads: [payload('workflow-arg')] },
                signalInput: { payloads: [payload('signal-arg')] },
                memo: { fields: { memo: payload('memo') } },
                searchAttributes: { indexedFields: { search: payload('search-attribute') } },
              })!,
            },
          },
        ],
      },
    })
  );
  const envelope = encoded.successful?.commands?.[0]?.scheduleNexusOperation?.input;
  t.is(envelope?.metadata?.encoding?.[0], 98);
  const request = new ProtobufBinaryPayloadConverter(
    protoRoot
  ).fromPayload<temporal.api.workflowservice.v1.ISignalWithStartWorkflowExecutionRequest>(envelope!);
  t.deepEqual(traceFromPayload(request.input?.payloads?.[0] as Payload), [
    'codec.encode.bound|workflow-arg|workflow.target-ns.target-id',
  ]);
  t.deepEqual(traceFromPayload(request.signalInput?.payloads?.[0] as Payload), [
    'codec.encode.bound|signal-arg|workflow.target-ns.target-id',
  ]);
  t.deepEqual(traceFromPayload(request.memo?.fields?.memo as Payload), [
    'codec.encode.bound|memo|workflow.target-ns.target-id',
  ]);
});

test('ordinary Nexus calls with a System Nexus service name are not rewritten', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'caller-ns',
    workflowId: 'caller-id',
  });
  const encoded = decodeCompletion(
    await runner.encodeCompletion({
      successful: {
        commands: [
          {
            scheduleNexusOperation: {
              seq: 43,
              endpoint: 'ordinary-endpoint',
              service: 'temporal.api.workflowservice.v1.WorkflowService',
              operation: 'SignalWithStartWorkflowExecution',
              input: payload('ordinary-nexus-input'),
            },
          },
        ],
      },
    })
  );
  const envelope = encoded.successful?.commands?.[0]?.scheduleNexusOperation?.input;
  t.not(envelope?.metadata?.encoding?.[0], 98);
  t.deepEqual(traceFromPayload(envelope), ['codec.encode.bound|ordinary-nexus-input|workflow.caller-ns.caller-id']);
});
