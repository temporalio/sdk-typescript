import test from 'ava';
import type { Payload, PayloadCodec } from '@temporalio/common';
import { ApplicationFailure, defaultFailureConverter, defaultPayloadConverter, u8 } from '@temporalio/common';
import { coresdk, temporal } from '@temporalio/proto';
import { WorkflowCodecRunner } from '@temporalio/worker/lib/workflow-codec-runner';
import { FreePayloadCodec, makeContextTrace } from './payload-converters/serialization-context-converter';

const SYSTEM_NEXUS_SERVICE = 'temporal.api.workflowservice.v1.WorkflowService';
const SIGNAL_WITH_START_OPERATION = 'SignalWithStartWorkflowExecution';
const SIGNAL_WITH_START_REQUEST_TYPE = 'temporal.api.workflowservice.v1.SignalWithStartWorkflowExecutionRequest';
const SIGNAL_WITH_START_RESPONSE_TYPE = 'temporal.api.workflowservice.v1.SignalWithStartWorkflowExecutionResponse';

function payload(label: string): Payload {
  return defaultPayloadConverter.toPayload(makeContextTrace(label));
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

function systemNexusPayload(
  messageTypeName: string,
  messageType: {
    create(properties?: any): any;
    encode(message: any): { finish(): Uint8Array };
  },
  properties: any
): Payload {
  return {
    metadata: { encoding: u8('binary/protobuf'), messageType: u8(messageTypeName) },
    data: messageType.encode(messageType.create(properties)).finish(),
  };
}

function utf8(bytes: Uint8Array | null | undefined): string | undefined {
  return bytes == null ? undefined : new TextDecoder().decode(bytes);
}

test('decodeActivation binds workflow codec context for initializeWorkflow payloads', async (t) => {
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
          arguments: [payload('wf-input')],
        },
      },
    ],
  });

  t.deepEqual(traceFromPayload(decoded.jobs?.[0]?.initializeWorkflow?.arguments?.[0] as Payload), [
    'codec.decode.bound|wf-input|workflow.default.wf-1',
  ]);
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

test('system Nexus operation envelopes visit nested payloads with workflow context', async (t) => {
  const runner = new WorkflowCodecRunner([new FreePayloadCodec()], {
    type: 'workflow',
    namespace: 'default',
    workflowId: 'wf-1',
  });

  const input = defaultPayloadConverter.toPayload({
    input: { payloads: [payload('workflow-arg')] },
    signalInput: { payloads: [payload('signal-arg')] },
    memo: { fields: { memo: payload('memo') } },
    searchAttributes: { indexedFields: { search: payload('search-attribute') } },
    header: { fields: { header: payload('header') } },
    userMetadata: {
      summary: payload('summary'),
      details: payload('details'),
    },
  })!;

  const encoded = decodeCompletion(
    await runner.encodeCompletion({
      successful: {
        commands: [
          {
            scheduleNexusOperation: {
              seq: 8,
              service: SYSTEM_NEXUS_SERVICE,
              operation: SIGNAL_WITH_START_OPERATION,
              input,
            },
          },
        ],
      },
    })
  );

  const encodedInput = encoded.successful?.commands?.[0]?.scheduleNexusOperation?.input as Payload;
  t.is(utf8(encodedInput.metadata?.encoding), 'binary/protobuf');
  t.is(utf8(encodedInput.metadata?.messageType), SIGNAL_WITH_START_REQUEST_TYPE);
  const request = temporal.api.workflowservice.v1.SignalWithStartWorkflowExecutionRequest.decode(encodedInput.data!);

  t.deepEqual(traceFromPayload(request.input?.payloads?.[0] as Payload), [
    'codec.encode.bound|workflow-arg|workflow.default.wf-1',
  ]);
  t.deepEqual(traceFromPayload(request.signalInput?.payloads?.[0] as Payload), [
    'codec.encode.bound|signal-arg|workflow.default.wf-1',
  ]);
  t.deepEqual(traceFromPayload(request.memo?.fields?.memo as Payload), [
    'codec.encode.bound|memo|workflow.default.wf-1',
  ]);
  t.deepEqual(traceFromPayload(request.header?.fields?.header as Payload), [
    'codec.encode.bound|header|workflow.default.wf-1',
  ]);
  t.deepEqual(traceFromPayload(request.userMetadata?.summary as Payload), [
    'codec.encode.bound|summary|workflow.default.wf-1',
  ]);
  t.deepEqual(traceFromPayload(request.userMetadata?.details as Payload), [
    'codec.encode.bound|details|workflow.default.wf-1',
  ]);
  t.deepEqual(traceFromPayload(request.searchAttributes?.indexedFields?.search as Payload), []);

  const decoded = await runner.decodeActivation({
    runId: 'run-1',
    jobs: [
      {
        resolveNexusOperation: {
          seq: 8,
          result: {
            completed: systemNexusPayload(
              SIGNAL_WITH_START_RESPONSE_TYPE,
              temporal.api.workflowservice.v1.SignalWithStartWorkflowExecutionResponse,
              { runId: 'started-run-id' }
            ),
          },
        },
      },
    ],
  });

  const decodedOutput = decoded.jobs?.[0]?.resolveNexusOperation?.result?.completed as Payload;
  t.is(utf8(decodedOutput.metadata?.encoding), 'json/plain');
  t.deepEqual(defaultPayloadConverter.fromPayload(decodedOutput), { runId: 'started-run-id' });
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
