/**
 * Error-marking: a non-benign failure surfaces as `"<type>: <message>"`; a
 * BENIGN `ApplicationFailure` leaves `error` unset.
 *
 * @module
 */

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

// Force the tracing gate on so activity-side runs emit deterministically regardless of ambient env.
process.env.LANGSMITH_TRACING = 'true';

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
        })
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
        })
      );
    },
  });

  const run = collector.byName('RunActivity:benignFailingActivity');
  t.truthy(run);
  // Benign failures leave `error` unset (undefined or null).
  t.is(run?.error == null, true);
});

test('error marking on workflow runs: does NOT mark a workflow that fails with a BENIGN-category failure', async (t) => {
  // Exercises the workflow-inbound error handler (its own `describeError` site), distinct from the activity path above.
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
        })
      );
    },
  });

  const run = collector.byName('RunWorkflow:BenignWorkflowDirect');
  t.truthy(run);
  t.is(run?.error == null, true);
});
