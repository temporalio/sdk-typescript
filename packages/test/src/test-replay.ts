import { temporal } from '@temporalio/proto';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import anyTest, { TestInterface } from 'ava';
import * as fs from 'fs';
import path from 'path';
import History = temporal.api.history.v1.History;

export interface Context {
  runtime: Runtime;
}

async function getHist(fname: string): Promise<History> {
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

function historator(hists: Array<History>, goSlow?: boolean) {
  return {
    timesCalled: 0,
    async *[Symbol.asyncIterator]() {
      for (const hist of hists) {
        this.timesCalled++;
        yield { workflowID: 'fake', history: hist };
        if (goSlow) {
          // This matters because the exception propagation from the worker takes a long time
          // compared to this generator. This sleep makes it more realistic for a
          // stream-from-net-or-disk situation
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    },
  };
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
  const hist = await getHist('cancel_fake_progress_history.bin');
  await Worker.runReplayHistory(
    {
      workflowsPath: require.resolve('./workflows'),
    },
    hist
  );
  t.pass();
});

test('cancel-fake-progress-replay from JSON', async (t) => {
  const hist = await getHist('cancel_fake_progress_history.json');
  await Worker.runReplayHistory(
    {
      workflowsPath: require.resolve('./workflows'),
    },
    hist
  );
  t.pass();
});

test('cancel-fake-progress-replay-nondeterministic', async (t) => {
  const hist = await getHist('cancel_fake_progress_history.bin');
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
  const hist = await getHist('cancel_fake_progress_history.bin');
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
  const hist1 = await getHist('cancel_fake_progress_history.bin');
  const hist2 = await getHist('cancel_fake_progress_history.json');
  const hists = historator([hist1, hist2]);

  const res = await Worker.runReplayHistories(
    {
      workflowsPath: require.resolve('./workflows'),
      replayName: t.title,
    },
    hists
  );
  t.deepEqual(hists.timesCalled, 2);
  t.deepEqual(res.hadAnyFailure, false);
  t.deepEqual(res.failureDetails.size, 0);
  t.pass();
});

test('multiple-histories-replay-fails-fast', async (t) => {
  const hist1 = await getHist('cancel_fake_progress_history.bin');
  const hist2 = await getHist('cancel_fake_progress_history.json');
  hist1.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';
  hist2.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';
  const hists = historator([hist1, hist2], true);

  await t.throwsAsync(
    Worker.runReplayHistories(
      {
        workflowsPath: require.resolve('./workflows'),
        replayName: t.title,
      },
      hists
    )
  );
  t.deepEqual(hists.timesCalled, 1);
});

test('multiple-histories-replay-fails-slow', async (t) => {
  const hist1 = await getHist('cancel_fake_progress_history.bin');
  const hist2 = await getHist('cancel_fake_progress_history.json');
  hist1.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';
  const hists = historator([hist1, hist2]);

  const res = await Worker.runReplayHistories(
    {
      workflowsPath: require.resolve('./workflows'),
      replayName: t.title,
      failFast: false,
    },
    hists
  );
  t.deepEqual(hists.timesCalled, 2);
  t.deepEqual(res.hadAnyFailure, true);
  t.deepEqual(res.failureDetails.size, 1);
});
