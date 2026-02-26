import test from 'ava';
import { coresdk } from '@temporalio/proto';
import { Payload, PayloadCodec, SerializationContext, defaultPayloadConverter } from '@temporalio/common';
import { WorkflowCodecRunner } from '@temporalio/worker/lib/workflow-codec-runner';

// A PayloadCodec that records which SerializationContext it was bound to on each encode/decode call.
// All instances created via withContext() share the same calls array.
class ContextTrackingCodec implements PayloadCodec {
  readonly calls: { op: 'encode' | 'decode'; context: SerializationContext | undefined }[];
  private readonly context?: SerializationContext;

  constructor(
    context?: SerializationContext,
    calls?: { op: 'encode' | 'decode'; context: SerializationContext | undefined }[]
  ) {
    this.context = context;
    this.calls = calls ?? [];
  }

  withContext(context: SerializationContext): PayloadCodec {
    return new ContextTrackingCodec(context, this.calls);
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    this.calls.push({ op: 'encode', context: this.context });
    return payloads;
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    this.calls.push({ op: 'decode', context: this.context });
    return payloads;
  }
}

async function initRunner(codec: ContextTrackingCodec): Promise<WorkflowCodecRunner> {
  const runner = new WorkflowCodecRunner([codec], 'default', 'test-task-queue');
  await runner.decodeActivation({
    runId: 'test-run-id',
    jobs: [{ initializeWorkflow: { workflowId: 'wf-id', workflowType: 'TestWorkflow', arguments: [] } }],
  } satisfies coresdk.workflow_activation.IWorkflowActivation);
  codec.calls.length = 0; // Clear init calls
  return runner;
}

function getRunState(runner: WorkflowCodecRunner): any {
  return (runner as any).serializationContextsByRunId.get('test-run-id');
}

function defaultPayload(value: unknown): Payload {
  const payload = defaultPayloadConverter.toPayload(value);
  if (payload == null) {
    throw new TypeError('Failed to encode payload');
  }
  return payload;
}

// --- Activity round-trip ---

test('scheduleActivity stores activity context and resolveActivity consumes it', async (t) => {
  const codec = new ContextTrackingCodec();
  const runner = await initRunner(codec);

  const expectedContext = {
    namespace: 'default',
    activityId: 'activity-1',
    workflowId: 'wf-id',
    workflowType: 'TestWorkflow',
    isLocal: false,
  };

  await runner.encodeCompletion({
    runId: 'test-run-id',
    successful: {
      commands: [
        {
          scheduleActivity: {
            seq: 1,
            activityId: 'activity-1',
            activityType: 'doThing',
            taskQueue: 'custom-q',
            arguments: [defaultPayload('arg')],
          },
        },
      ],
    },
  } satisfies coresdk.workflow_completion.IWorkflowActivationCompletion);

  // Verify stored context
  const runState = getRunState(runner);
  t.deepEqual(runState.activityContexts.get(1), expectedContext);

  // Verify codec was called with activity context for encoding
  t.is(codec.calls.length, 1);
  t.is(codec.calls[0].op, 'encode');
  t.deepEqual(codec.calls[0].context, expectedContext);
  codec.calls.length = 0;

  // Resolve the activity
  await runner.decodeActivation({
    runId: 'test-run-id',
    jobs: [{ resolveActivity: { seq: 1, result: { completed: { result: defaultPayload('result') } } } }],
  } satisfies coresdk.workflow_activation.IWorkflowActivation);

  // Verify codec was called with activity context for decoding
  t.is(codec.calls.length, 1);
  t.is(codec.calls[0].op, 'decode');
  t.deepEqual(codec.calls[0].context, expectedContext);

  // Verify context was cleaned up
  t.false(runState.activityContexts.has(1));
});

// --- Local activity round-trip ---

test('scheduleLocalActivity stores local activity context and resolveActivity consumes it', async (t) => {
  const codec = new ContextTrackingCodec();
  const runner = await initRunner(codec);

  const expectedContext = {
    namespace: 'default',
    activityId: 'local-1',
    workflowId: 'wf-id',
    workflowType: 'TestWorkflow',
    isLocal: true,
  };

  await runner.encodeCompletion({
    runId: 'test-run-id',
    successful: {
      commands: [
        {
          scheduleLocalActivity: {
            seq: 1,
            activityId: 'local-1',
            activityType: 'localThing',
            arguments: [defaultPayload('arg')],
          },
        },
      ],
    },
  } satisfies coresdk.workflow_completion.IWorkflowActivationCompletion);

  const runState = getRunState(runner);
  t.deepEqual(runState.activityContexts.get(1), expectedContext);

  t.is(codec.calls.length, 1);
  t.deepEqual(codec.calls[0].context, expectedContext);
  codec.calls.length = 0;

  await runner.decodeActivation({
    runId: 'test-run-id',
    jobs: [{ resolveActivity: { seq: 1, result: { completed: { result: defaultPayload('result') } } } }],
  } satisfies coresdk.workflow_activation.IWorkflowActivation);

  t.is(codec.calls.length, 1);
  t.deepEqual(codec.calls[0].context, expectedContext);
  t.false(runState.activityContexts.has(1));
});

// --- Child workflow round-trip ---

test('startChildWorkflowExecution stores child context and resolveChildWorkflowExecution consumes it', async (t) => {
  const codec = new ContextTrackingCodec();
  const runner = await initRunner(codec);

  const expectedContext = { namespace: 'default', workflowId: 'child-wf-id' };

  await runner.encodeCompletion({
    runId: 'test-run-id',
    successful: {
      commands: [
        {
          startChildWorkflowExecution: {
            seq: 1,
            workflowId: 'child-wf-id',
            workflowType: 'ChildWf',
            input: [defaultPayload('arg')],
          },
        },
      ],
    },
  } satisfies coresdk.workflow_completion.IWorkflowActivationCompletion);

  const runState = getRunState(runner);
  t.deepEqual(runState.childWorkflowContexts.get(1), expectedContext);

  // Codec called with child context for encoding input
  const encodeCalls = codec.calls.filter((c) => c.op === 'encode');
  t.true(
    encodeCalls.some((c) => c.context?.namespace === 'default' && (c.context as any).workflowId === 'child-wf-id')
  );
  codec.calls.length = 0;

  await runner.decodeActivation({
    runId: 'test-run-id',
    jobs: [
      { resolveChildWorkflowExecution: { seq: 1, result: { completed: { result: defaultPayload('child-result') } } } },
    ],
  } satisfies coresdk.workflow_activation.IWorkflowActivation);

  t.is(codec.calls.length, 1);
  t.deepEqual(codec.calls[0].context, expectedContext);
  t.false(runState.childWorkflowContexts.has(1));
});

// --- Workflow-level commands use workflow context ---

test('workflow-level commands use workflow context', async (t) => {
  const codec = new ContextTrackingCodec();
  const runner = await initRunner(codec);

  const workflowContext = { namespace: 'default', workflowId: 'wf-id' };

  await runner.encodeCompletion({
    runId: 'test-run-id',
    successful: {
      commands: [{ completeWorkflowExecution: { result: defaultPayload('done') } }],
    },
  } satisfies coresdk.workflow_completion.IWorkflowActivationCompletion);

  t.is(codec.calls.length, 1);
  t.is(codec.calls[0].op, 'encode');
  t.deepEqual(codec.calls[0].context, workflowContext);
});

test('respondToQuery uses workflow context', async (t) => {
  const codec = new ContextTrackingCodec();
  const runner = await initRunner(codec);

  const workflowContext = { namespace: 'default', workflowId: 'wf-id' };

  await runner.encodeCompletion({
    runId: 'test-run-id',
    successful: {
      commands: [{ respondToQuery: { queryId: 'q1', succeeded: { response: defaultPayload('answer') } } }],
    },
  } satisfies coresdk.workflow_completion.IWorkflowActivationCompletion);

  // respondToQuery encodes response payload
  const encodeCalls = codec.calls.filter((c) => c.op === 'encode');
  t.true(encodeCalls.length > 0);
  t.deepEqual(encodeCalls[0].context, workflowContext);
});

test('failWorkflowExecution uses workflow context', async (t) => {
  const codec = new ContextTrackingCodec();
  const runner = await initRunner(codec);

  const workflowContext = { namespace: 'default', workflowId: 'wf-id' };

  await runner.encodeCompletion({
    runId: 'test-run-id',
    successful: {
      commands: [
        { failWorkflowExecution: { failure: { message: 'boom', encodedAttributes: defaultPayload({ key: 'val' }) } } },
      ],
    },
  } satisfies coresdk.workflow_completion.IWorkflowActivationCompletion);

  // Failure encoding processes the encodedAttributes payload
  const encodeCalls = codec.calls.filter((c) => c.op === 'encode');
  t.true(encodeCalls.length > 0);
  t.deepEqual(encodeCalls[0].context, workflowContext);
});

// --- Signal/cancel external independence (existing test, updated to use helpers) ---

test('signal/cancel external context maps are independent', async (t) => {
  const runner = new WorkflowCodecRunner([], 'default', 'test-task-queue');

  await runner.decodeActivation({
    runId: 'test-run-id',
    jobs: [{ initializeWorkflow: { workflowId: 'parent-workflow-id', workflowType: 'test-workflow', arguments: [] } }],
  } satisfies coresdk.workflow_activation.IWorkflowActivation);

  await runner.encodeCompletion({
    runId: 'test-run-id',
    successful: {
      commands: [
        {
          signalExternalWorkflowExecution: {
            seq: 1,
            signalName: 'test-signal',
            args: [],
            headers: {},
            workflowExecution: {
              namespace: 'default',
              workflowId: 'signal-target-workflow-id',
              runId: 'signal-target-run-id',
            },
          },
        },
        {
          requestCancelExternalWorkflowExecution: {
            seq: 1,
            workflowExecution: {
              namespace: 'default',
              workflowId: 'cancel-target-workflow-id',
              runId: 'cancel-target-run-id',
            },
          },
        },
      ],
    },
  } satisfies coresdk.workflow_completion.IWorkflowActivationCompletion);

  const runState = (runner as any).serializationContextsByRunId.get('test-run-id');
  t.truthy(runState);
  t.is(runState.signalExternalWorkflowContexts.get(1)?.workflowId, 'signal-target-workflow-id');
  t.is(runState.cancelExternalWorkflowContexts.get(1)?.workflowId, 'cancel-target-workflow-id');

  await runner.decodeActivation({
    runId: 'test-run-id',
    jobs: [{ resolveSignalExternalWorkflow: { seq: 1 } }, { resolveRequestCancelExternalWorkflow: { seq: 1 } }],
  } satisfies coresdk.workflow_activation.IWorkflowActivation);

  t.false(runState.signalExternalWorkflowContexts.has(1));
  t.false(runState.cancelExternalWorkflowContexts.has(1));
});

// --- Context-free fallback (existing test) ---

test('gracefully falls back to context-free codec execution without run state', async (t) => {
  class CodecThatFailsIfContextBound implements PayloadCodec {
    withContext(): PayloadCodec {
      throw new Error('withContext must not be called for context-free fallback');
    }

    async encode(payloads: Payload[]): Promise<Payload[]> {
      return payloads;
    }

    async decode(payloads: Payload[]): Promise<Payload[]> {
      return payloads;
    }
  }

  const runner = new WorkflowCodecRunner([new CodecThatFailsIfContextBound()], 'default', 'test-task-queue');

  const queryArg = defaultPayload('query-arg');
  const decodedActivation = await runner.decodeActivation({
    runId: 'missing-state-run-id',
    jobs: [{ queryWorkflow: { queryType: 'q', queryId: 'id', arguments: [queryArg], headers: {} } }],
  } satisfies coresdk.workflow_activation.IWorkflowActivation);
  const decodedQueryPayload = decodedActivation.jobs[0]?.queryWorkflow?.arguments?.[0];
  t.truthy(decodedQueryPayload);
  t.is(defaultPayloadConverter.fromPayload(decodedQueryPayload!), 'query-arg');

  const completionBytes = await runner.encodeCompletion({
    runId: 'missing-state-run-id',
    successful: { commands: [{ completeWorkflowExecution: { result: defaultPayload('completion-result') } }] },
  } satisfies coresdk.workflow_completion.IWorkflowActivationCompletion);
  const completion = coresdk.workflow_completion.WorkflowActivationCompletion.decodeDelimited(completionBytes);
  t.truthy(completion.successful?.commands?.[0]?.completeWorkflowExecution?.result);
});

// --- forgetRun ---

test('forgetRun clears all state for a run', async (t) => {
  const codec = new ContextTrackingCodec();
  const runner = await initRunner(codec);

  // Schedule an activity to populate seq state
  await runner.encodeCompletion({
    runId: 'test-run-id',
    successful: {
      commands: [
        { scheduleActivity: { seq: 1, activityType: 'act', taskQueue: 'q', arguments: [defaultPayload('x')] } },
      ],
    },
  } satisfies coresdk.workflow_completion.IWorkflowActivationCompletion);

  t.truthy(getRunState(runner));

  runner.forgetRun('test-run-id');

  t.is(getRunState(runner), undefined);
});
