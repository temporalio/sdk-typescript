import { randomUUID } from 'crypto';
import { Client, WorkflowFailedError } from '@temporalio/client';
import { workflowInterceptorModules } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';
import { decodeOptionalSinglePayload } from '@temporalio/common/lib/internal-non-workflow';
import { bundlerOptions, TestWorkflowEnvironment } from './helpers';
import {
  makeConfigurableEnvironmentTestFn,
  configurableHelpers,
  createTestWorkflowEnvironment,
  Context,
} from './helpers-integration';
import {
  currentWorkflowContext,
  echoQuery,
  echoUpdate,
  unblockSignal,
  messagePassingContexts,
  wfContextWithRemoteActivity,
  wfContextWithHeartbeatDetails,
  wfContextWithLocalActivity,
  wfContextWithContinueAsNew,
  wfContextWithChildWorkflow,
  wfFailureContext,
  wfActivityFailureContext,
  wfExternalSignalFailureContext,
  wfExternalCancelFailureContext,
  wfContextSmoke,
  wfContextWithUpsertMemo,
  wfContextWithTimerSummary,
  wfChildWorkflowFailureContext,
  wfExternalSignalSuccessContext,
  wfLocalActivityFailureContext,
} from './workflows/serialization-context';
import { makeContextTrace } from './payload-converters/serialization-context-converter';
import { echoTrace, heartbeatTrace } from './activities/serialization-context';
import { throwAnError } from './activities';

const converterPath = require.resolve('./payload-converters/serialization-context-converter');
const dataConverter = { payloadConverterPath: converterPath, failureConverterPath: converterPath };

const test = makeConfigurableEnvironmentTestFn<Context>({
  createTestContext: async () => {
    const env = await createTestWorkflowEnvironment();
    const workflowBundle = await bundleWorkflowCode({
      ...bundlerOptions,
      workflowInterceptorModules: [...workflowInterceptorModules],
      workflowsPath: require.resolve('./workflows/serialization-context'),
      payloadConverterPath: converterPath,
      failureConverterPath: converterPath,
    });
    return { env, workflowBundle };
  },
  teardown: async (c) => {
    await c.env.teardown();
  },
});

function makeClient(env: TestWorkflowEnvironment): Client {
  return new Client({
    connection: env.client.connection,
    namespace: env.client.options.namespace,
    dataConverter,
  });
}

// Helper to assert workflow serialization context in trace string
function workflowCtx(workflowId: string): string {
  return `workflow.default.${workflowId}`;
}
// Helper to assert activity serialization context in trace string
function activityCtx(workflowId: string, activityId = '1', isLocal = false): string {
  return `activity.default.${workflowId}.${activityId}.${isLocal}`;
}

// Helper to assert payload encoding in trace string
function enc(label: string, ctx: string): string {
  return `payload.encode.bound|${label}|${ctx}`;
}
// Helper to assert payload decoding in trace string
function dec(label: string, ctx: string): string {
  return `payload.decode.bound|${label}|${ctx}`;
}
// Helper to assert paired payload encode/decode operations in trace strings
function encdec(label: string, ctx: string): string[] {
  return [enc(label, ctx), dec(label, ctx)];
}

test('workflow start/result payloads carry workflow context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const workflowId = `wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(currentWorkflowContext, {
      args: [makeContextTrace('wf-input')],
      workflowId,
      taskQueue: h.taskQueue,
    });
    const wfTrace = await handle.result();
    t.deepEqual(wfTrace, {
      label: 'wf-output',
      trace: [...encdec('wf-input', wf), ...encdec('wf-output', wf)],
    });
  });
});

test('query/signal/update carry workflow context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const workflowId = `wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(messagePassingContexts, {
      workflowId,
      taskQueue: h.taskQueue,
    });
    const queryTrace = await handle.query(echoQuery, makeContextTrace('query-input'));
    const updateTrace = await handle.executeUpdate(echoUpdate, { args: [makeContextTrace('update-input')] });
    await handle.signal(unblockSignal, makeContextTrace('signal-input'));
    const signalTrace = await handle.result();
    t.deepEqual(queryTrace, {
      label: 'query-output',
      trace: [...encdec('query-input', wf), ...encdec('query-output', wf)],
    });
    t.deepEqual(updateTrace, {
      label: 'update-output',
      trace: [...encdec('update-input', wf), ...encdec('update-output', wf)],
    });
    t.deepEqual(signalTrace, {
      label: 'signal-received',
      trace: [...encdec('signal-input', wf), ...encdec('signal-received', wf)],
    });
  });
});

test('activity carries serialization context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter, activities: { echoTrace } });
  const workflowId = `wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);
  const act = activityCtx(workflowId);
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfContextWithRemoteActivity, {
      args: [makeContextTrace('wf-input')],
      workflowId,
      taskQueue: h.taskQueue,
    });
    const wfTrace = await handle.result();
    t.deepEqual(wfTrace, {
      label: 'wf-output',
      trace: [
        ...encdec('wf-input', wf),
        ...encdec('activity-input', act),
        ...encdec('activity-output', act),
        ...encdec('wf-output', wf),
      ],
    });
  });
});

test('activity heartbeat carries workflow context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({
    dataConverter,
    activities: { heartbeatTrace },
  });
  const workflowId = `wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);
  const act = activityCtx(workflowId);
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfContextWithHeartbeatDetails, {
      args: [makeContextTrace('wf-input')],
      workflowId,
      taskQueue: h.taskQueue,
    });
    const wfTrace = await handle.result();
    t.deepEqual(wfTrace, {
      label: 'wf-output',
      trace: [
        ...encdec('wf-input', wf),
        ...encdec('activity-input', act),
        ...encdec('activity-heartbeat-details', act),
        ...encdec('activity-heartbeat-details', act),
        ...encdec('wf-output', wf),
      ],
    });
  });
});

test('local activity carries serialization context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter, activities: { echoTrace } });
  const workflowId = `wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);
  const localAct = activityCtx(workflowId, '1', true);
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfContextWithLocalActivity, {
      args: [makeContextTrace('wf-input')],
      workflowId,
      taskQueue: h.taskQueue,
    });
    const wfTrace = await handle.result();
    t.deepEqual(wfTrace, {
      label: 'wf-output',
      trace: [
        ...encdec('wf-input', wf),
        ...encdec('local-activity-input', localAct),
        ...encdec('local-activity-output', localAct),
        ...encdec('wf-output', wf),
      ],
    });
  });
});

test('workflow continue-as-new carry workflow context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const workflowId = `wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfContextWithContinueAsNew, {
      args: [makeContextTrace('wf-input'), true],
      workflowId,
      taskQueue: h.taskQueue,
    });
    const wfTrace = await handle.result();
    t.deepEqual(wfTrace, {
      label: 'wf-output',
      trace: [
        ...encdec('wf-input', wf),
        ...encdec('continue-as-new', wf),
        ...encdec('wf-output', wf),
      ],
    });
  });
});

test('child workflow carry workflow context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const workflowId = `wf-id-${randomUUID()}`;
  const childId = `child-wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);
  const childWf = workflowCtx(childId);
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfContextWithChildWorkflow, {
      args: [makeContextTrace('parent-wf-input'), childId],
      workflowId,
      taskQueue: h.taskQueue,
    });
    const wfTrace = await handle.result();
    t.deepEqual(wfTrace, {
      label: 'parent-wf-output',
      trace: [
        ...encdec('parent-wf-input', wf),
        ...encdec('child-wf-input', childWf),
        ...encdec('child-wf-output', childWf),
        ...encdec('parent-wf-output', wf),
      ],
    });
  });
});

test('workflow failure carries workflow failure context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const workflowId = `wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfFailureContext, {
      workflowId,
      taskQueue: h.taskQueue,
    });

    const err = (await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;

    t.is(err.cause?.message, `failure.decode.bound|${wf}|failure.encode.bound|${wf}|wf-failure`);
  });
});

test('activity failure observed by workflow carries workflow decode context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({
    dataConverter,
    activities: { throwAnError },
  });
  const workflowId = `wf-id-${randomUUID()}`;
  const act = activityCtx(workflowId);

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfActivityFailureContext, {
      workflowId,
      taskQueue: h.taskQueue,
    });

    const message = await handle.result();
    t.is(message, `failure.decode.bound|${act}|Activity task failed`);
  });
});

test('external signal failure carries target workflow decode context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const missingWfId = `missing-wf-id-${randomUUID()}`;
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfExternalSignalFailureContext, {
      workflowId: `wf-id-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [missingWfId],
    });

    const message = await handle.result();
    t.is(
      message,
      `failure.decode.bound|workflow.default.${missingWfId}|Unable to signal external workflow because it was not found`
    );
  });
});

test('external cancel failure carries target workflow decode context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const missingWfId = `missing-wf-id-${randomUUID()}`;

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfExternalCancelFailureContext, {
      workflowId: `wf-id-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [missingWfId],
    });

    const message = await handle.result();
    t.is(
      message,
      `failure.decode.bound|workflow.default.${missingWfId}|Unable to cancel external workflow because not found`
    );
  });
});

test('workflow upsertMemo carries workflow context on encode', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const workflowId = `wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfContextWithUpsertMemo, {
      args: [makeContextTrace('wf-input')],
      workflowId,
      taskQueue: h.taskQueue,
    });

    const wfTrace = await handle.result();
    t.deepEqual(wfTrace, {
      label: 'wf-output',
      trace: [
        ...encdec('wf-input', wf),
        enc('memo-upsert', wf),
        ...encdec('wf-output', wf),
      ],
    });
  });
});

// Timer summary is string metadata, not a ContextTrace payload so there is no
// ContextTrace to inspect.
// This test only verifies that the summary still round-trips through history.
// (it does not prove serialization-context tracing the way the ContextTrace tests do)
test('timer summary still serializes', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const workflowId = `wf-id-${randomUUID()}`;

  await worker.runUntil(async () => {
    await client.workflow.execute(wfContextWithTimerSummary, {
      args: [makeContextTrace('wf-input')],
      workflowId,
      taskQueue: h.taskQueue,
    });

    const resp = await t.context.env.client.workflowService.getWorkflowExecutionHistory({
      namespace: t.context.env.client.options.namespace,
      execution: { workflowId },
    });

    const timerStarted = resp.history?.events?.find((e) => e.timerStartedEventAttributes != null);

    t.is(
      await decodeOptionalSinglePayload(
        t.context.env.client.options.loadedDataConverter,
        timerStarted?.userMetadata?.summary
      ),
      'timer-summary'
    );
  });
});

test('workflow with many payload boundaries', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter, activities: { echoTrace } });
  const workflowId = `wf-id-${randomUUID()}`;
  const childId = `child-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);
  const childWf1 = workflowCtx(childId);
  const childWf2 = workflowCtx(childId + '-2');
  const act = activityCtx(workflowId, '1', false);
  const localAct = activityCtx(workflowId, '2', true);
  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfContextSmoke, {
      args: [makeContextTrace('wf-input'), true, childId],
      workflowId,
      taskQueue: h.taskQueue,
    });
    const wfTrace = await handle.result();
    t.deepEqual(wfTrace, {
      label: 'wf-output',
      trace: [
        ...encdec('wf-input', wf),

        ...encdec('activity-input', act),
        ...encdec('activity-output', act),

        ...encdec('local-activity-input', localAct),
        ...encdec('local-activity-output', localAct),

        ...encdec('child-wf-input', childWf1),
        ...encdec('child-wf-output', childWf1),

        ...encdec('continue-as-new', wf),

        ...encdec('activity-input', act),
        ...encdec('activity-output', act),

        ...encdec('local-activity-input', localAct),
        ...encdec('local-activity-output', localAct),

        ...encdec('child-wf-input', childWf2),
        ...encdec('child-wf-output', childWf2),

        ...encdec('wf-output', wf),
      ],
    });
  });
});

test('external signal success carries target workflow context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const workflowId = `wf-id-${randomUUID()}`;
  const childId = `child-wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);
  const childWf = workflowCtx(childId);

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfExternalSignalSuccessContext, {
      args: [makeContextTrace('wf-input'), childId],
      workflowId,
      taskQueue: h.taskQueue,
    });

    const wfTrace = await handle.result();
    t.deepEqual(wfTrace, {
      label: 'wf-output',
      trace: [
        ...encdec('wf-input', wf),
        ...encdec('signal-input', childWf),
        ...encdec('signal-received', childWf),
        ...encdec('wf-output', wf),
      ],
    });
  });
});

test('child workflow failure observed by parent carries child workflow decode context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const workflowId = `wf-id-${randomUUID()}`;
  const childId = `child-wf-id-${randomUUID()}`;
  const childWf = workflowCtx(childId);

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfChildWorkflowFailureContext, {
      args: [childId],
      workflowId,
      taskQueue: h.taskQueue,
    });

    const message = await handle.result();
    t.is(message, `failure.decode.bound|${childWf}|Child Workflow execution failed`);
  });
});

test('local activity failure observed by workflow carries local activity decode context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({
    dataConverter,
    activities: { throwAnError },
  });
  const workflowId = `wf-id-${randomUUID()}`;
  const localAct = activityCtx(workflowId, '1', true);

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(wfLocalActivityFailureContext, {
      workflowId,
      taskQueue: h.taskQueue,
    });

    const message = await handle.result();
    t.is(message, `failure.decode.bound|${localAct}|failure.encode.bound|${localAct}|local-activity-failure`);
  });
});
