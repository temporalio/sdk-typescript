/**
 * Continue-as-new trace continuity: the successor run keeps the same LangSmith
 * trace while having a distinct, deterministic run id.
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
  t.not(first.id, second.id);
  t.is(first.trace_id, second.trace_id);

  // No ContinueAsNew run is emitted — only the trace context is propagated.
  t.falsy(collector.byName('ContinueAsNew:ContinueAsNewWorkflow'));
});

// When no parent is propagated, the successor must install its own fresh placeholder
// root so its user `traceable` run stays a proper root, not dangling under the
// predecessor's never-emitted parent.
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
  t.is(inner!.parent_run_id, undefined);
  // dumpTraces throws on a dangling parent_run_id; no throw confirms the link.
  t.notThrows(() => dumpTraces(collector.records));
});
