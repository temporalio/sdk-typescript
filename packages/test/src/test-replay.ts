import { DefaultLogger, ReplayCore, Worker } from '@temporalio/worker';
import anyTest, { TestInterface } from 'ava';
import { temporal } from '@temporalio/proto';
import History = temporal.api.history.v1.History;
import path from 'path';
import * as fs from 'fs';

export interface Context {
  replayCore: ReplayCore;
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
  // TODO: Auto-setup of worker for these kinds of tests

  const histBin = await fs.promises.readFile(
    path.resolve(__dirname, '../src/history_files/cancel_fake_progress_history.bin')
  );
  const hist = History.decode(histBin);
  await Worker.createReplay(
    {
      workflowsPath: require.resolve('./workflows'),
      testName: 'cancel-fake-progress-replay',
    },
    hist
  );
  t.pass();
});
