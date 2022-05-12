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
      replayName: t.title,
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
        replayName: t.title,
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
