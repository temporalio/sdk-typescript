import type { TestFn } from 'ava';
import anyTest from 'ava';
import { defaultPayloadConverter, toPayloads } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import type { WorkflowBundle } from '@temporalio/worker';
import { bundleWorkflowCode, ReplayError } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import { loadHistory, Worker } from './helpers';

async function gen2array<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) {
    out.push(x);
  }
  return out;
}

export interface Context {
  bundle: WorkflowBundle;
}

function historator(histories: Array<temporal.api.history.v1.History>) {
  return (async function* () {
    for (const history of histories) {
      yield { workflowId: 'fake', history };
    }
  })();
}

const test = anyTest as TestFn<Context>;

test.before(async (t) => {
  // We don't want AVA to whine about unhandled rejections thrown by workflows
  process.removeAllListeners('unhandledRejection');
  const bundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });

  t.context = {
    bundle,
  };
});

test('cancel-fake-progress-replay', async (t) => {
  const hist = await loadHistory('cancel_fake_progress_history.bin');
  await Worker.runReplayHistory(
    {
      workflowBundle: t.context.bundle,
    },
    hist
  );
  t.pass();
});

test('cancel-fake-progress-replay from JSON', async (t) => {
  const hist = await loadHistory('cancel_fake_progress_history.json');
  await Worker.runReplayHistory(
    {
      workflowBundle: t.context.bundle,
    },
    hist
  );
  t.pass();
});

for (const useStartChild of [false, true]) {
  test(`replay invalid child versioning override with ${useStartChild ? 'startChild' : 'executeChild'}`, async (t) => {
    const override = { pinnedTo: { deploymentName: 'deployment', buildId: 'build' } };
    const history = temporal.api.history.v1.History.fromObject({
      events: [
        {
          eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
          workflowExecutionStartedEventAttributes: {
            workflowType: { name: 'childWorkflowVersioningOverride' },
            taskQueue: { name: 'test' },
            input: { payloads: toPayloads(defaultPayloadConverter, override, useStartChild) },
            originalExecutionRunId: '11111111-1111-4111-8111-111111111111',
            workflowTaskTimeout: { seconds: 10 },
          },
        },
        {
          eventType: 'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED',
          workflowTaskScheduledEventAttributes: { taskQueue: { name: 'test' }, attempt: 1 },
        },
        {
          eventType: 'EVENT_TYPE_WORKFLOW_TASK_STARTED',
          workflowTaskStartedEventAttributes: { scheduledEventId: 2 },
        },
        {
          eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED',
          workflowTaskCompletedEventAttributes: { scheduledEventId: 2, startedEventId: 3 },
        },
        {
          eventType: 'EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED',
          startChildWorkflowExecutionInitiatedEventAttributes: {
            namespace: 'default',
            workflowId: 'child-workflow',
            workflowType: { name: 'successString' },
            taskQueue: { name: 'test' },
            workflowTaskCompletedEventId: 4,
            versioningOverride: { pinned: { version: override.pinnedTo, behavior: 1 } },
          },
        },
        {
          eventType: 'EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_FAILED',
          startChildWorkflowExecutionFailedEventAttributes: {
            namespace: 'default',
            workflowId: 'child-workflow',
            workflowType: { name: 'successString' },
            cause: 'START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_INVALID_VERSIONING_OVERRIDE',
            initiatedEventId: 5,
            workflowTaskCompletedEventId: 4,
          },
        },
        {
          eventType: 'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED',
          workflowTaskScheduledEventAttributes: { taskQueue: { name: 'test' }, attempt: 1 },
        },
        {
          eventType: 'EVENT_TYPE_WORKFLOW_TASK_STARTED',
          workflowTaskStartedEventAttributes: { scheduledEventId: 7 },
        },
        {
          eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED',
          workflowTaskCompletedEventAttributes: { scheduledEventId: 7, startedEventId: 8 },
        },
        {
          eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
          workflowExecutionCompletedEventAttributes: {
            workflowTaskCompletedEventId: 9,
            result: { payloads: toPayloads(defaultPayloadConverter, 'invalid versioning override') },
          },
        },
      ].map((event, index) => ({
        ...event,
        eventId: index + 1,
        eventTime: { seconds: 1_700_000_000 + index },
      })),
    });

    await Worker.runReplayHistory({ workflowBundle: t.context.bundle }, history);
    t.pass();
  });
}

test('runReplayHistory closes replay iterator after first result', async (t) => {
  const hist = { events: [{ eventId: 1 }] };
  let iteratorClosed = false;

  class TestWorker extends Worker {
    public static override async *runReplayHistories(): AsyncIterableIterator<{
      workflowId: string;
      runId: string;
    }> {
      try {
        yield { workflowId: 'fake', runId: 'run' };
      } finally {
        iteratorClosed = true;
      }
    }
  }

  await TestWorker.runReplayHistory({ workflowBundle: t.context.bundle }, hist);

  t.true(iteratorClosed);
});

test('cancel-fake-progress-replay-nondeterministic', async (t) => {
  const hist = await loadHistory('cancel_fake_progress_history.bin');
  // Manually alter the workflow type to point to different workflow code
  hist.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';

  await t.throwsAsync(
    Worker.runReplayHistory(
      {
        workflowBundle: t.context.bundle,
      },
      hist
    ),
    {
      instanceOf: DeterminismViolationError,
    }
  );
});

test('workflow-task-failure-fails-replay', async (t) => {
  const hist = await loadHistory('cancel_fake_progress_history.bin');
  // Manually alter the workflow type to point to our workflow which will fail workflow tasks
  hist.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'failsWorkflowTask';

  await t.throwsAsync(
    Worker.runReplayHistory(
      {
        workflowBundle: t.context.bundle,
        replayName: t.title,
      },
      hist
    ),
    { instanceOf: ReplayError }
  );
});

test('multiple-histories-replay', async (t) => {
  const hist1 = await loadHistory('cancel_fake_progress_history.bin');
  const hist2 = await loadHistory('cancel_fake_progress_history.json');
  const histories = historator([hist1, hist2]);

  const res = await gen2array(
    Worker.runReplayHistories(
      {
        workflowBundle: t.context.bundle,
        replayName: t.title,
      },
      histories
    )
  );
  t.deepEqual(
    res.map(({ error }) => error),
    [undefined, undefined]
  );
});

test('multiple-histories-replay-returns-errors', async (t) => {
  const hist1 = await loadHistory('cancel_fake_progress_history.bin');
  const hist2 = await loadHistory('cancel_fake_progress_history.json');
  // change workflow type to break determinism
  hist1.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';
  hist2.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';
  const histories = historator([hist1, hist2]);

  const results = await gen2array(
    Worker.runReplayHistories(
      {
        workflowBundle: t.context.bundle,
        replayName: t.title,
      },
      histories
    )
  );

  t.is(results.filter(({ error }) => error instanceof DeterminismViolationError).length, 2);
});

test('empty-histories-replay-returns-empty-result', async (t) => {
  const histories = historator([]);

  const res = await gen2array(
    Worker.runReplayHistories(
      {
        workflowBundle: t.context.bundle,
      },
      histories
    )
  );
  t.is(res.length, 0);
});
