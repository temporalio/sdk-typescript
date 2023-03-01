/* eslint-disable @typescript-eslint/no-non-null-assertion */

import * as fs from 'fs';
import path from 'path';
import anyTest, { TestFn } from 'ava';
import { temporal } from '@temporalio/proto';
import { bundleWorkflowCode, DefaultLogger, ReplayError, Runtime, WorkflowBundle } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import { Worker } from './helpers';
import History = temporal.api.history.v1.History;

async function gen2array<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) {
    out.push(x);
  }
  return out;
}

export interface Context {
  runtime: Runtime;
  bundle: WorkflowBundle;
}

async function getHistories(fname: string): Promise<History> {
  const isJson = fname.endsWith('json');
  const fpath = path.resolve(__dirname, `../history_files/${fname}`);
  if (isJson) {
    const hist = await fs.promises.readFile(fpath, 'utf8');
    return JSON.parse(hist);
  } else {
    const hist = await fs.promises.readFile(fpath);
    return History.decode(hist);
  }
}

function historator(histories: Array<History>) {
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
  const logger = new DefaultLogger('DEBUG');
  const runtime = Runtime.install({ logger });
  const bundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });

  t.context = {
    runtime,
    bundle,
  };
});

test('cancel-fake-progress-replay', async (t) => {
  const hist = await getHistories('cancel_fake_progress_history.bin');
  await Worker.runReplayHistory(
    {
      workflowBundle: t.context.bundle,
    },
    hist
  );
  t.pass();
});

test('cancel-fake-progress-replay from JSON', async (t) => {
  const hist = await getHistories('cancel_fake_progress_history.json');
  await Worker.runReplayHistory(
    {
      workflowBundle: t.context.bundle,
    },
    hist
  );
  t.pass();
});

test('cancel-fake-progress-replay-nondeterministic', async (t) => {
  const hist = await getHistories('cancel_fake_progress_history.bin');
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
  const hist = await getHistories('cancel_fake_progress_history.bin');
  // Manually alter the workflow type to point to our workflow which will fail workflow tasks
  hist.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'failsWorkflowTask';

  const err: ReplayError | undefined = await t.throwsAsync(
    Worker.runReplayHistory(
      {
        workflowBundle: t.context.bundle,
        replayName: t.title,
      },
      hist
    ),
    { instanceOf: ReplayError }
  );
  t.false(err?.isNonDeterminism);
});

test('multiple-histories-replay', async (t) => {
  const hist1 = await getHistories('cancel_fake_progress_history.bin');
  const hist2 = await getHistories('cancel_fake_progress_history.json');
  const histories = historator([hist1, hist2]);

  const res = await gen2array(
    Worker.runReplayHistories(
      {
        workflowsPath: require.resolve('./workflows'),
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
  const hist1 = await getHistories('cancel_fake_progress_history.bin');
  const hist2 = await getHistories('cancel_fake_progress_history.json');
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

  t.is(results.filter(({ error }) => error instanceof ReplayError && error.isNonDeterminism).length, 2);
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
