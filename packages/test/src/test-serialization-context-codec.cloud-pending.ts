import { randomUUID } from 'crypto';
import { Client } from '@temporalio/client';
import { workflowInterceptorModules } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from './helpers';
import { bundlerOptions } from './helpers';
import type { Context } from './helpers-integration';
import {
  makeConfigurableEnvironmentTestFn,
  configurableHelpers,
  createTestWorkflowEnvironment,
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
  wfContextWithChildWorkflow,
  wfContextWithUpsertMemo,
} from './workflows/serialization-context';
import { FreePayloadCodec, makeContextTrace } from './payload-converters/serialization-context-converter';
import { echoTrace, heartbeatTrace } from './activities/serialization-context';

const dataConverter = { payloadCodecs: [new FreePayloadCodec()] };

const test = makeConfigurableEnvironmentTestFn<Context>({
  createTestContext: async () => {
    const env = await createTestWorkflowEnvironment();
    const workflowBundle = await bundleWorkflowCode({
      ...bundlerOptions,
      workflowInterceptorModules: [...workflowInterceptorModules],
      workflowsPath: require.resolve('./workflows/serialization-context'),
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

function workflowCtx(workflowId: string): string {
  return `workflow.default.${workflowId}`;
}

function activityCtx(workflowId: string, activityId = '1', isLocal = false): string {
  return `activity.default.${workflowId}.${activityId}.${isLocal}`;
}

function codecRoundTrip(label: string, ctx: string): string[] {
  return [`codec.encode.bound|${label}|${ctx}`, `codec.decode.bound|${label}|${ctx}`];
}

test('workflow start/result codec path carries workflow context', async (t) => {
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
      trace: [...codecRoundTrip('wf-input', wf), ...codecRoundTrip('wf-output', wf)],
    });
  });
});

test('query, signal, and update codec paths carry workflow context', async (t) => {
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
      trace: [...codecRoundTrip('query-input', wf), ...codecRoundTrip('query-output', wf)],
    });
    t.deepEqual(updateTrace, {
      label: 'update-output',
      trace: [...codecRoundTrip('update-input', wf), ...codecRoundTrip('update-output', wf)],
    });
    t.deepEqual(signalTrace, {
      label: 'signal-received',
      trace: [...codecRoundTrip('signal-input', wf), ...codecRoundTrip('signal-received', wf)],
    });
  });
});

test('remote activity codec path carries activity context', async (t) => {
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
        ...codecRoundTrip('wf-input', wf),
        ...codecRoundTrip('activity-input', act),
        ...codecRoundTrip('activity-output', act),
        ...codecRoundTrip('wf-output', wf),
      ],
    });
  });
});

test('activity heartbeat codec path carries activity context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter, activities: { heartbeatTrace } });
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
        ...codecRoundTrip('wf-input', wf),
        ...codecRoundTrip('activity-input', act),
        ...codecRoundTrip('activity-heartbeat-details', act),
        ...codecRoundTrip('activity-heartbeat-details', act),
        ...codecRoundTrip('wf-output', wf),
      ],
    });
  });
});

test('local activity codec path carries local-activity context', async (t) => {
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
        ...codecRoundTrip('wf-input', wf),
        ...codecRoundTrip('local-activity-input', localAct),
        ...codecRoundTrip('local-activity-output', localAct),
        ...codecRoundTrip('wf-output', wf),
      ],
    });
  });
});

test('child workflow codec path carries target workflow context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });
  const workflowId = `wf-id-${randomUUID()}`;
  const childId = `child-wf-id-${randomUUID()}`;
  const wf = workflowCtx(workflowId);
  const childWf = workflowCtx(childId);

  await worker.runUntil(async () => {
    const childHandle = await client.workflow.start(wfContextWithChildWorkflow, {
      args: [makeContextTrace('parent-wf-input'), childId],
      workflowId,
      taskQueue: h.taskQueue,
    });

    t.deepEqual(await childHandle.result(), {
      label: 'parent-wf-output',
      trace: [
        ...codecRoundTrip('parent-wf-input', wf),
        ...codecRoundTrip('child-wf-input', childWf),
        ...codecRoundTrip('child-wf-output', childWf),
        ...codecRoundTrip('parent-wf-output', wf),
      ],
    });
  });
});

test('memo codec path carries workflow context', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const memoHandle = await client.workflow.start(wfContextWithUpsertMemo, {
      args: [makeContextTrace('wf-input')],
      workflowId: `wf-id-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    const memoWorkflowId = memoHandle.workflowId;
    const memoWf = workflowCtx(memoWorkflowId);
    await memoHandle.result();
    const desc = await memoHandle.describe();

    t.deepEqual(desc.memo?.probe, {
      label: 'memo-upsert',
      trace: [...codecRoundTrip('wf-input', memoWf), ...codecRoundTrip('memo-upsert', memoWf)],
    });
  });
});
