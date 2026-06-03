/**
 * Continue-as-new trace continuity.
 *
 * When a workflow continues as new, the successor run must keep the same
 * LangSmith trace: the outbound `continueAsNew` interceptor emits a
 * `ContinueAsNew:` marker and propagates the current trace context through the
 * continue-as-new input, and the successor's inbound `execute` reconstructs that
 * context. The two `RunWorkflow:` spans therefore share a `trace_id` while
 * having distinct (deterministic) run ids.
 *
 * This boots a real environment and runs a workflow that continues as new once.
 *
 * @module
 */

process.env.LANGSMITH_TRACING = 'true';

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

test('continue-as-new: keeps the successor on the same trace with a distinct run id', async (t) => {
  const collector = new InMemoryRunCollector();
  const result = await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: { simpleActivity: activities.simpleActivity },
    body: async ({ client, taskQueue }) =>
      client.workflow.execute(workflows.ContinueAsNewWorkflow, {
        taskQueue,
        workflowId: `can-${Date.now()}`,
        args: [0],
      }),
  });

  t.is(result, 1);

  const runs = collector.records.filter((r) => r.name === 'RunWorkflow:ContinueAsNewWorkflow');
  t.is(runs.length, 2);
  const first = runs[0]!;
  const second = runs[1]!;
  // Distinct deterministic run ids...
  t.not(first.id, second.id);
  // ...but the same trace carries across the continue-as-new boundary.
  t.is(first.trace_id, second.trace_id);

  t.truthy(collector.byName('ContinueAsNew:ContinueAsNewWorkflow'));
});
