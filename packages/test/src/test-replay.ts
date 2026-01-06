/* eslint-disable @typescript-eslint/no-non-null-assertion */

import type { TestFn } from 'ava';
import anyTest from 'ava';
import type { temporal } from '@temporalio/proto';
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
