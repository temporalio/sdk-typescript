/**
 * Environment kill-switch end-to-end.
 *
 * When `LANGSMITH_TRACING` (or any of the recognized aliases) is disabled, the
 * plugin must emit nothing — no client markers, no workflow-operation runs, no
 * activity runs. This boots a real local environment and runs a workflow with
 * no user `traceable` anywhere, so an empty collector proves the plugin itself
 * emitted nothing rather than merely that there was nothing to emit.
 *
 * The flag is restored after the suite so a non-isolated test pool does not
 * leak the disabled state into sibling files.
 *
 * @module
 */

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

const ORIGINAL = process.env.LANGSMITH_TRACING;

test.before(() => {
  process.env.LANGSMITH_TRACING = 'false';
});

test.after.always(() => {
  if (ORIGINAL === undefined) {
    delete process.env.LANGSMITH_TRACING;
  } else {
    process.env.LANGSMITH_TRACING = ORIGINAL;
  }
});

test('LANGSMITH_TRACING kill-switch: suppresses all emission when tracing is disabled', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: { plainActivity: activities.plainActivity },
    body: async ({ client, taskQueue }) => {
      await client.workflow.execute(workflows.PlainWorkflow, {
        taskQueue,
        workflowId: `env-${Date.now()}`,
        args: ['hi'],
      });
    },
  });

  t.deepEqual(collector.records, []);
});
