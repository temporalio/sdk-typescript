import { temporal } from '@temporalio/proto';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import anyTest, { TestInterface } from 'ava';
import * as fs from 'fs';
import path from 'path';
const History = temporal.api.history.v1.History;

export interface Context {
  runtime: Runtime;
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
  const histBin = await fs.promises.readFile(
    path.resolve(__dirname, '../history_files/cancel_fake_progress_history.bin')
  );
  const hist = History.decode(histBin);
  await Worker.runReplayHistory(
    {
      workflowsPath: require.resolve('./workflows'),
    },
    hist
  );
  t.pass();
});

test('cancel-fake-progress-replay from JSON', async (t) => {
  const histJson = await fs.promises.readFile(
    path.resolve(__dirname, '../history_files/cancel_fake_progress_history.json'),
    'utf8'
  );
  const hist = JSON.parse(histJson);
  await Worker.runReplayHistory(
    {
      workflowsPath: require.resolve('./workflows'),
    },
    hist
  );
  t.pass();
});

test('cancel-fake-progress-replay-nondeterministic', async (t) => {
  const histBin = await fs.promises.readFile(
    path.resolve(__dirname, '../history_files/cancel_fake_progress_history.bin')
  );
  const hist = History.decode(histBin);

  // Manually alter the workflow type to point to different workflow code
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  hist.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';

  await t.throwsAsync(
    Worker.runReplayHistory(
      {
        workflowsPath: require.resolve('./workflows'),
      },
      hist
    ),
    {
      instanceOf: DeterminismViolationError,
    }
  );
});

test('workflow-task-failure-fails-replay', async (t) => {
  const histBin = await fs.promises.readFile(
    path.resolve(__dirname, '../history_files/cancel_fake_progress_history.bin')
  );
  const hist = History.decode(histBin);

  // Manually alter the workflow type to point to our workflow which will fail workflow tasks
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  hist.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'failsWorkflowTask';

  await t.throwsAsync(
    Worker.runReplayHistory(
      {
        workflowsPath: require.resolve('./workflows'),
        replayName: t.title,
      },
      hist
    )
  );
});

test('multiple-histories-replay', async (t) => {
  const histBin = await fs.promises.readFile(
    path.resolve(__dirname, '../history_files/cancel_fake_progress_history.bin')
  );
  const hist1 = History.decode(histBin);
  const histJson = await fs.promises.readFile(
    path.resolve(__dirname, '../history_files/cancel_fake_progress_history.json'),
    'utf8'
  );
  const hist2 = JSON.parse(histJson);
  let timesCalled = 0;
  const hists = {
    async *[Symbol.asyncIterator]() {
      timesCalled++;
      yield { workflowID: '1', history: hist1 };
      timesCalled++;
      yield { workflowID: '2', history: hist2 };
      timesCalled++;
    },
  };

  const res = await Worker.runReplayHistories(
    {
      workflowsPath: require.resolve('./workflows'),
      replayName: t.title,
    },
    hists
  );
  t.deepEqual(timesCalled, 3);
  t.deepEqual(res.hadAnyFailure, false);
  t.deepEqual(res.failureDetails.size, 0);
  t.pass();
});

test('multiple-histories-replay-fails-fast', async (t) => {
  const histBin = await fs.promises.readFile(
    path.resolve(__dirname, '../history_files/cancel_fake_progress_history.bin')
  );
  const hist1 = History.decode(histBin);
  hist1.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';
  const histJson = await fs.promises.readFile(
    path.resolve(__dirname, '../history_files/cancel_fake_progress_history.json'),
    'utf8'
  );
  const hist2 = JSON.parse(histJson);
  hist2.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';

  let timesCalled = 0;
  const hists = {
    async *[Symbol.asyncIterator]() {
      timesCalled++;
      yield { workflowID: '1', history: hist1 };
      timesCalled++;
      yield { workflowID: '2', history: hist2 };
      timesCalled++;
    },
  };

  await t.throwsAsync(
    Worker.runReplayHistories(
      {
        workflowsPath: require.resolve('./workflows'),
        replayName: t.title,
      },
      hists
    )
  );
  t.deepEqual(timesCalled, 1);
});
