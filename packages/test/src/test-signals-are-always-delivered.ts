/**
 * Tests that if a signal is delivered while the Worker is processing a Workflow
 * Task, the Worker picks up a new Workflow Task (including the signal) and
 * the Workflow library delivers the signal to user code before it starts the
 * Workflow execution.
 *
 * @module
 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient } from '@temporalio/client';
import { Worker, DefaultLogger, Runtime, InjectedSinks } from '@temporalio/worker';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
import * as workflows from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test.before(async () => {
    Runtime.install({ logger: new DefaultLogger('DEBUG') });
  });

  test('Signals are always delivered', async (t) => {
    const taskQueue = 'test-signal-delivery';
    const conn = new WorkflowClient();
    const wf = await conn.start(workflows.signalsAreAlwaysProcessed, { taskQueue, workflowId: uuid4() });

    const sinks: InjectedSinks<workflows.SignalProcessTestSinks> = {
      controller: {
        sendSignal: {
          async fn() {
            // Send a signal to the Workflow which will cause the WFT to fail
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

    await worker.runUntil(wf.result());

    // Workflow completes if it got the signal
    t.pass();
  });
}
