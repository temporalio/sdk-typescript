import test from 'ava';
import { WorkflowClient } from '@temporalio/client';
import { Worker, DefaultLogger, Core, InjectedSinks } from '@temporalio/worker';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
import * as workflows from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test.before(async () => {
    await Core.install({ logger: new DefaultLogger('DEBUG') });
  });

  test('Signals are always delivered', async (t) => {
    const taskQueue = 'test-signal-delivery';
    const conn = new WorkflowClient();
    const wf = await conn.start(workflows.signalsAreAlwaysProcessed, { taskQueue, workflowTaskTimeout: '3s' });

    const sinks: InjectedSinks<workflows.SignalProcessTestSinks> = {
      controller: {
        sendSignal: {
          async fn() {
            await wf.signal(workflows.incrementSignal);
          },
        },
      },
    };

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      sinks,
    });

    await Promise.all([
      worker.run(),
      (async () => {
        try {
          await wf.result();
        } finally {
          worker.shutdown();
        }
      })(),
    ]);

    // Workflow completes if it got the signal
    t.pass();
  });
}
