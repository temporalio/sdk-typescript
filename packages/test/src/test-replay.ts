/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { temporal } from '@temporalio/proto';
import { DefaultLogger, ReplayError, Runtime, Worker } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import anyTest, { TestInterface } from 'ava';
import * as fs from 'fs';
import path from 'path';
import History = temporal.api.history.v1.History;

export interface Context {
  runtime: Runtime;
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

const test = anyTest as TestInterface<Context>;

test.before(async (t) => {
  // We don't want AVA to whine about unhandled rejections thrown by workflows
  process.removeAllListeners('unhandledRejection');
  const logger = new DefaultLogger('DEBUG');
  const runtime = Runtime.install({ logger });
  t.context = {
    runtime,
  };
});

test('cancel-fake-progress-replay', async (t) => {
  const hist = await getHistories('cancel_fake_progress_history.bin');
  await Worker.runReplayHistory(
    {
      workflowsPath: require.resolve('./workflows'),
    },
    hist
  );
  t.pass();
});

test('cancel-fake-progress-replay from JSON', async (t) => {
  const hist = await getHistories('cancel_fake_progress_history.json');
  await Worker.runReplayHistory(
    {
      workflowsPath: require.resolve('./workflows'),
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
        workflowsPath: require.resolve('./workflows'),
        failFast: false, // Verify this flag is ignored for single replay
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

  const err: ReplayError = await t.throwsAsync(
    Worker.runReplayHistory(
      {
        workflowsPath: require.resolve('./workflows'),
        replayName: t.title,
      },
      hist
    ),
    { instanceOf: ReplayError }
  );
  t.false(err.isNonDeterminism);
});

test('multiple-histories-replay', async (t) => {
  const hist1 = await getHistories('cancel_fake_progress_history.bin');
  const hist2 = await getHistories('cancel_fake_progress_history.json');
  const histories = historator([hist1, hist2]);

  const res = await Worker.runReplayHistories(
    {
      workflowsPath: require.resolve('./workflows'),
      replayName: t.title,
    },
    histories
  );
  t.is(res.errors.length, 0);
});

test('multiple-histories-replay-fails-fast', async (t) => {
  const hist1 = await getHistories('cancel_fake_progress_history.bin');
  const hist2 = await getHistories('cancel_fake_progress_history.json');
  // change workflow type to break determinism
  hist1.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';
  hist2.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';
  const histories = historator([hist1, hist2]);

  await t.throwsAsync(
    Worker.runReplayHistories(
      {
        workflowsPath: require.resolve('./workflows'),
        replayName: t.title,
      },
      histories
    )
  );
});

test('multiple-histories-replay-fails-slow', async (t) => {
  const hist1 = await getHistories('cancel_fake_progress_history.bin');
  const hist2 = await getHistories('cancel_fake_progress_history.json');
  // change workflow type to break determinism
  hist1.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';
  const histories = historator([hist1, hist2]);

  const res = await Worker.runReplayHistories(
    {
      workflowsPath: require.resolve('./workflows'),
      replayName: t.title,
      failFast: false,
    },
    histories
  );
  t.is(res.errors.length, 1);
});
