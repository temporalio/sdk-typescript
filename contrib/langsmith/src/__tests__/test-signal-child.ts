/**
 * Workflow-side signal-child marker lifecycle.
 *
 * When a workflow signals another workflow from inside its body, the outbound
 * `signalWorkflow` interceptor emits a `SignalChildWorkflow:` marker. Like every
 * other marker, it must be CLOSED (an `updateRun`/end recorded) so it does not
 * show as perpetually running in LangSmith, while still being propagated as the
 * parent of the signalled workflow's run.
 *
 * @module
 */

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

process.env.LANGSMITH_TRACING = 'true';

test('signal-child: emits a closed SignalChildWorkflow marker nested under the workflow run', async (t) => {
  const collector = new InMemoryRunCollector();
  const result = await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: { simpleActivity: activities.simpleActivity },
    workerOptions: { maxCachedWorkflows: 2 },
    body: async ({ client, taskQueue }) =>
      client.workflow.execute(workflows.SignalChildWorkflow, {
        taskQueue,
        workflowId: `signal-child-${Date.now()}`,
        args: ['hello'],
      }),
  });

  t.is(result, 'hello');

  const marker = collector.byName('SignalChildWorkflow:my_signal');
  t.truthy(marker, 'a SignalChildWorkflow: marker run was emitted');
  t.not(marker!.end_time, undefined, 'marker run has an end_time (was closed)');
  t.is(collector.parentNameOf('SignalChildWorkflow:my_signal'), 'RunWorkflow:SignalChildWorkflow');
});
