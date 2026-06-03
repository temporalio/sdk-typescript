/**
 * Error-marking parity with the Python plugin.
 *
 * A non-benign activity failure must surface on the `RunActivity:` run as
 * `"<type>: <message>"`; a `BENIGN`-category `ApplicationFailure` is an expected
 * outcome and must leave the run's `error` unset. Both cases boot a real local
 * Temporal environment and let the activity actually throw.
 *
 * @module
 */

// User opted into tracing by installing the plugin; force the gate on so the
// activity-side runs emit deterministically regardless of ambient env.
process.env.LANGSMITH_TRACING = 'true';

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

const ACTIVITIES = {
  failingActivity: activities.failingActivity,
  benignFailingActivity: activities.benignFailingActivity,
};

test('error marking on activity runs: marks a non-benign activity failure as "<type>: <message>"', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      await t.throwsAsync(
        client.workflow.execute(workflows.ErrorWorkflow, {
          taskQueue,
          workflowId: `error-${Date.now()}`,
        }),
      );
    },
  });

  t.is(collector.byName('RunActivity:failingActivity')?.error, 'ApplicationError: activity-failed');
});

test('error marking on activity runs: does NOT mark a BENIGN-category failure as errored', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      await t.throwsAsync(
        client.workflow.execute(workflows.BenignWorkflow, {
          taskQueue,
          workflowId: `benign-${Date.now()}`,
        }),
      );
    },
  });

  const run = collector.byName('RunActivity:benignFailingActivity');
  t.truthy(run);
  // Benign failures leave `error` unset (undefined or null), matching Python.
  t.is(run?.error == null, true);
});

test('error marking on workflow runs: does NOT mark a workflow that fails with a BENIGN-category failure', async (t) => {
  // Distinct from the activity-inbound benign path above: this exercises the
  // *workflow-inbound* error handler, which has its own `describeError` call
  // site. A workflow that throws a BENIGN `ApplicationFailure` directly (no
  // activity) is an expected control-flow outcome — the `RunWorkflow:` run
  // must not be marked errored, or every benign stop would pollute the trace.
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      await t.throwsAsync(
        client.workflow.execute(workflows.BenignWorkflowDirect, {
          taskQueue,
          workflowId: `benign-direct-${Date.now()}`,
        }),
      );
    },
  });

  const run = collector.byName('RunWorkflow:BenignWorkflowDirect');
  t.truthy(run);
  t.is(run?.error == null, true);
});
