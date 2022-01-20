import { DefaultLogger, ReplayCore, Core, Worker } from '@temporalio/worker';
import anyTest, { TestInterface } from 'ava';
import { temporal } from '@temporalio/proto';
const History = temporal.api.history.v1.History;
import path from 'path';
import * as fs from 'fs';

export interface Context {
  replayCore: Core;
}

const test = anyTest as TestInterface<Context>;

test.before(async (t) => {
  const logger = new DefaultLogger('DEBUG');
  // Use forwarded logging from core
  const replayCore = await ReplayCore.install({ logger, telemetryOptions: { logForwardingLevel: 'INFO' } });
  t.context = {
    replayCore,
  };
});

test('cancel-fake-progress-replay', async (t) => {
  const histBin = await fs.promises.readFile(
    path.resolve(__dirname, '../src/history_files/cancel_fake_progress_history.bin')
  );
  const hist = History.decode(histBin);
  await Worker.runReplayHistory(
    {
      workflowsPath: require.resolve('./workflows'),
      testName: 'cancel-fake-progress-replay',
    },
    hist
  );
  t.pass();
});

test.skip('cancel-fake-progress-replay-nondeterministic', async (t) => {
  const histBin = await fs.promises.readFile(
    path.resolve(__dirname, '../src/history_files/cancel_fake_progress_history.bin')
  );
  const hist = History.decode(histBin);
  // Manually alter the workflow type to point to different workflow code
  hist.events[0].workflowExecutionStartedEventAttributes!.workflowType!.name = 'http';

  // TODO: Should throw when nondeterminism error is encountered but need feedback on best way
  //   to intercept
  await Worker.runReplayHistory(
    {
      workflowsPath: require.resolve('./workflows'),
      testName: 'cancel-fake-progress-replay',
    },
    hist
  );
  t.pass();
});
