/**
 * Tests that if a signal is delivered while the Worker is processing a Workflow
 * Task, the Worker picks up a new Workflow Task (including the signal) and
 * the Workflow library delivers the signal to user code before it starts the
 * Workflow execution.
 *
 * @module
 */
import type { InjectedSinks } from '@temporalio/worker';
import { helpers, makeTestFunction } from './helpers-integration';
import * as workflows from './workflows';

const test = makeTestFunction({ workflowsPath: require.resolve('./workflows') });

test('Signals are always delivered', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const wf = await startWorkflow(workflows.signalsAreAlwaysProcessed);

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

  const worker = await createWorker({ sinks });

  await worker.runUntil(wf.result());

  // Workflow completes if it got the signal
  t.pass();
});
