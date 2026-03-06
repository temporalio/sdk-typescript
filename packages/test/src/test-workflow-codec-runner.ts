import test from 'ava';
import { coresdk } from '@temporalio/proto';
import { Payload, PayloadCodec, SerializationContext, defaultPayloadConverter } from '@temporalio/common';
import { WorkflowCodecRunner } from '@temporalio/worker/lib/workflow-codec-runner';

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

// Guard against seq map memory leaks: forgetRun must clear all tracked state for a workflow run.
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
