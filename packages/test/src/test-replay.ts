import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestFn } from 'ava';
import anyTest from 'ava';
import type { Client } from '@temporalio/client';
import type { temporal } from '@temporalio/proto';
import type { WorkflowBundle } from '@temporalio/worker';
import { bundleWorkflowCode, ReplayError, Runtime } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import { echo, fakeProgress, queryOwnWf } from './activities';
import { loadHistory, Worker } from './helpers';
import { testWorkflowHistory } from './helpers-history';
import { smorgasbord } from './workflows/smorgasbord';

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

test.serial('Replay keeps its runtime alive while another replay finishes during bundling', async (t) => {
  const history = await loadHistory('cancel_fake_progress_history.bin');
  let bundlingStarted!: () => void;
  const started = new Promise<void>((resolve) => (bundlingStarted = resolve));
  let resumeBundling!: () => void;
  const resume = new Promise<void>((resolve) => (resumeBundling = resolve));
  const replay = t.notThrowsAsync(
    Worker.runReplayHistory(
      {
        workflowsPath: require.resolve('./workflows'),
        bundlerOptions: {
          webpackConfigHook(config) {
            config.plugins ??= [];
            config.plugins.push({
              apply(compiler) {
                compiler.hooks.beforeCompile.tapPromise('pause-replay-bundling', async () => {
                  bundlingStarted();
                  await resume;
                });
              },
            });
            return config;
          },
        },
      },
      history
    )
  );
  await started;
  try {
    await Worker.runReplayHistory({ workflowBundle: t.context.bundle }, history);
  } finally {
    resumeBundling();
  }
  await replay;
});

test.serial('Replay releases its runtime when preparation fails', async (t) => {
  const history = await loadHistory('cancel_fake_progress_history.bin');
  await t.throwsAsync(
    Worker.runReplayHistory({ workflowBundle: { codePath: `${__dirname}/nonexistent-workflow-bundle.js` } }, history),
    { code: 'ENOENT' }
  );
  t.is(Runtime._instance, undefined);
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

const smorgasbordHistoryOptions = {
  sdkVersion: '1.24.0',
  workflowsPath: require.resolve('./workflows'),
  workerOptions: { activities: { echo, fakeProgress, queryOwnWf } },
};

// Each capture starts a fresh workflow at iteration 0, then selects just the run
// for its scenario. Continue-As-New is specific to smorgasbord, not the helper.
async function captureSmorgasbordRun(client: Client, taskQueue: string, continueAsNewCount: number) {
  const handle = await client.workflow.start(smorgasbord, {
    taskQueue,
    workflowId: randomUUID(),
    workflowExecutionTimeout: '2m',
    args: [],
  });
  await handle.result();

  let history = await client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
  for (let count = 0; count < continueAsNewCount; count++) {
    const runId = history.events?.at(-1)?.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId;
    assert(runId, 'Expected smorgasbord to Continue-As-New');
    history = await client.workflow.getHandle(handle.workflowId, runId).fetchHistory();
  }
  return history;
}

testWorkflowHistory({
  ...smorgasbordHistoryOptions,
  title: 'smorgasbord run 1',
  filename: 'smorgasbord-cancellation-sdk-1.24.0.json',
  generate: (client, taskQueue) => captureSmorgasbordRun(client, taskQueue, 0),
});

testWorkflowHistory({
  ...smorgasbordHistoryOptions,
  title: 'smorgasbord run 2',
  filename: 'smorgasbord-activities-continue-as-new-sdk-1.24.0.json',
  generate: (client, taskQueue) => captureSmorgasbordRun(client, taskQueue, 1),
});

testWorkflowHistory({
  ...smorgasbordHistoryOptions,
  title: 'smorgasbord run 3',
  filename: 'smorgasbord-activities-completion-sdk-1.24.0.json',
  generate: (client, taskQueue) => captureSmorgasbordRun(client, taskQueue, 2),
});
