import { randomUUID } from 'node:crypto';
import path from 'node:path';
import asyncRetry from 'async-retry';
import type Long from 'long';
import type { WorkflowHandle, WorkflowHandleWithFirstExecutionRunId } from '@temporalio/client';
import type { temporal } from '@temporalio/proto';
import { createTestWorkflowBundle } from '@temporalio/test-helpers';
import { Worker } from '@temporalio/worker';
import { helpers, makeTestFunction } from './helpers-integration';
import * as workflows from './workflows';
import { loadHistory } from './helpers';

const test = makeTestFunction({ workflowsPath: path.join(__dirname, 'workflows') });

type RandomStreamResetWorkflow = typeof workflows.randomStreamResetWorkflow;
type RandomStreamResetHandle = WorkflowHandle<RandomStreamResetWorkflow>;
type StartedRandomStreamResetHandle = WorkflowHandleWithFirstExecutionRunId<RandomStreamResetWorkflow>;
type RandomStreamResetCapture = workflows.RandomStreamResetCapture;

async function waitForCaptures(handle: RandomStreamResetHandle, count: number): Promise<RandomStreamResetCapture[]> {
  return await asyncRetry(
    async () => {
      const captures = await handle.query(workflows.randomStreamResetCapturesQuery);
      if (captures.length < count) {
        throw new Error(`Expected at least ${count} random stream reset captures, got ${captures.length}`);
      }
      return captures;
    },
    {
      retries: 30,
      minTimeout: 100,
      maxTimeout: 1000,
    }
  );
}

function getFirstTimerWorkflowTaskCompletedEventId(history: temporal.api.history.v1.IHistory): Long {
  const timerStarted = history.events?.find((event) => event.timerStartedEventAttributes != null);
  const workflowTaskCompletedEventId = timerStarted?.timerStartedEventAttributes?.workflowTaskCompletedEventId;
  if (workflowTaskCompletedEventId == null) {
    throw new Error('Could not find timer-started event with workflow task completed event id');
  }
  return workflowTaskCompletedEventId;
}

test.serial('named random streams are reseeded after workflow reset', async (t) => {
  const { env } = t.context;
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  let initialCaptures: RandomStreamResetCapture[] | undefined;
  const handle: StartedRandomStreamResetHandle = await worker.runUntil(async () => {
    const handle = await startWorkflow(workflows.randomStreamResetWorkflow);
    initialCaptures = await waitForCaptures(handle, 2);
    return handle;
  });

  const [a, b] = initialCaptures ?? [];
  if (a == null || b == null) {
    throw new Error('Expected initial workflow execution to capture two random stream groups');
  }

  const history = await handle.fetchHistory();
  const workflowTaskFinishEventId = getFirstTimerWorkflowTaskCompletedEventId(history);
  const reset = await env.client.workflowService.resetWorkflowExecution({
    namespace: env.client.options.namespace,
    workflowExecution: {
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    },
    workflowTaskFinishEventId,
    reason: 'test named random stream reset behavior',
    requestId: randomUUID(),
    identity: 'typescript-sdk-test',
  });
  if (reset.runId == null || reset.runId === '') {
    throw new Error('Workflow reset did not return a new run id');
  }

  const resetHandle = env.client.workflow.getHandle<RandomStreamResetWorkflow>(handle.workflowId, reset.runId);
  const resetWorker = await createWorker();
  const [c, d] = await resetWorker.runUntil(async () => {
    const captures = await waitForCaptures(resetHandle, 2);
    await resetHandle.signal(workflows.randomStreamResetUnblockSignal);
    await resetHandle.result();
    return captures;
  });
  if (c == null || d == null) {
    throw new Error('Expected reset workflow execution to capture two random stream groups');
  }

  t.deepEqual(c, a);

  t.not(b.random, a.random);
  t.not(b.uuid, a.uuid);
  t.not(b.childWorkflowId, a.childWorkflowId);

  t.not(d.random, c.random);
  t.not(d.uuid, c.uuid);
  t.not(d.childWorkflowId, c.childWorkflowId);

  t.not(d.random, b.random);
  t.not(d.uuid, b.uuid);
  t.not(d.childWorkflowId, b.childWorkflowId);
});

test.serial('can replay history with randoms from 1.17.2', async (t) => {
  const hist = await loadHistory('random-replay-1.17.2.json');
  await t.notThrowsAsync(async () => {
    await Worker.runReplayHistory(
      {
        workflowBundle: await createTestWorkflowBundle({
          workflowsPath: require.resolve('./workflows/random-streams'),
        }),
      },
      hist
    );
  });
});
