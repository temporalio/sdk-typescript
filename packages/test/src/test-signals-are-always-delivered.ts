/**
 * Tests that if a signal is delivered while the Worker is processing a Workflow
 * Task, the Worker picks up a new Workflow Task (including the signal) and
 * the Workflow library delivers the signal to user code before it starts the
 * Workflow execution.
 *
 * @module
 */
import { randomUUID } from 'crypto';
import test from 'ava';
import { WorkflowClient } from '@temporalio/client';
import type { InjectedSinks } from '@temporalio/worker';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { createTestWorkflowEnvironment } from './helpers-integration';
import * as workflows from './workflows';

if (RUN_INTEGRATION_TESTS) {
  let env: Awaited<ReturnType<typeof createTestWorkflowEnvironment>>;

  test.before(async () => {
    Runtime.install({ logger: new DefaultLogger('DEBUG') });
    env = await createTestWorkflowEnvironment();
  });
  test.after.always(async () => {
    await env.teardown();
  });

  test('Signals are always delivered', async (t) => {
    const taskQueue = `test-signal-delivery-${randomUUID()}`;
    const conn = new WorkflowClient({ connection: env.connection, namespace: env.namespace });
    const wf = await conn.start(workflows.signalsAreAlwaysProcessed, { taskQueue, workflowId: randomUUID() });

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
      connection: env.nativeConnection,
      namespace: env.namespace,
    });

    await worker.runUntil(wf.result());

    // Workflow completes if it got the signal
    t.pass();
  });
}
