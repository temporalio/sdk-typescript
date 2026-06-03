/**
 * Continue-as-new trace continuity.
 *
 * When a workflow continues as new, the successor run must keep the same
 * LangSmith trace: the outbound `continueAsNew` interceptor propagates the
 * current trace context through the continue-as-new input (it emits no run of
 * its own, matching the Python plugin), and the successor's inbound `execute`
 * reconstructs that context. The two `RunWorkflow:` spans therefore share a
 * `trace_id` while having distinct (deterministic) run ids.
 *
 * This boots a real environment and runs a workflow that continues as new once.
 *
 * @module
 */

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, dumpTraces, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

process.env.LANGSMITH_TRACING = 'true';

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

  // No ContinueAsNew run is emitted (parity with the Python plugin) — only the
  // trace context is propagated, which the matching trace_ids above confirm.
  t.falsy(collector.byName('ContinueAsNew:ContinueAsNewWorkflow'));
});

// With `addTemporalRuns: false` and no client-side `traceable` wrapping the
// start, nothing is propagated into the workflow, so the inbound installs a
// placeholder root that is never emitted. The `continueAsNew` interceptor must
// therefore propagate no trace context, letting the successor install its own
// fresh placeholder root so its user `traceable` run stays a proper root instead
// of dangling under the predecessor's never-emitted parent.
test('continue-as-new: successor user runs stay roots when no parent was propagated', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: false },
    activities: { simpleActivity: activities.simpleActivity },
    body: async ({ client, taskQueue }) =>
      client.workflow.execute(workflows.ContinueAsNewTraceableWorkflow, {
        taskQueue,
        workflowId: `can-root-${Date.now()}`,
        args: [0],
      }),
  });

  const inner = collector.byName('workflow_inner_call');
  t.truthy(inner);
  // The successor's user run is a real root, not dangling under the
  // predecessor's never-emitted placeholder root.
  t.is(inner!.parent_run_id, undefined);
  // dumpTraces throws on a dangling parent_run_id; no throw confirms the link.
  t.notThrows(() => dumpTraces(collector.records));
});
