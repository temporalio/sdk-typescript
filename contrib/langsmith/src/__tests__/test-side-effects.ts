/**
 * Replay side-effect counting under forced cache eviction.
 *
 * With `maxCachedWorkflows: 0` every workflow task after the first replays the
 * workflow from the start of history. If replay suppression were broken, the
 * workflow-origin runs (`RunWorkflow:`, `StartActivity:`) would be re-emitted on
 * each replayed task and `createRun` would fire more times than there are
 * distinct runs. This test counts raw `createRun` invocations and asserts it
 * equals the number of distinct collected runs — i.e. every run was emitted
 * exactly once despite eviction.
 *
 * @module
 */

process.env.LANGSMITH_TRACING = 'true';

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, dumpTraces, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

const SIMPLE_TREE = [
  'StartWorkflow:SimpleWorkflow',
  'RunWorkflow:SimpleWorkflow',
  '  StartActivity:simpleActivity',
  '  RunActivity:simpleActivity',
].join('\n');

test('replay side effects: emits each run exactly once even when the workflow is evicted and replayed', async (t) => {
  const collector = new InMemoryRunCollector();

  // Count every createRun that reaches the collector (including any duplicate
  // a broken replay guard would produce). createRun is a mutable arrow
  // property, and callers read it at call time, so wrapping it here is seen.
  let rawCreate = 0;
  const inner = collector.createRun;
  collector.createRun = async (run: Record<string, unknown>): Promise<void> => {
    rawCreate += 1;
    return inner(run);
  };

  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: { simpleActivity: activities.simpleActivity },
    workerOptions: { maxCachedWorkflows: 0 },
    body: async ({ client, taskQueue }) => {
      await client.workflow.execute(workflows.SimpleWorkflow, {
        taskQueue,
        workflowId: `side-effects-${Date.now()}`,
        args: ['hi'],
      });
    },
  });

  t.is(dumpTraces(collector.records), SIMPLE_TREE);
  // No run was created more than once: raw calls == distinct ids.
  t.is(rawCreate, collector.createOrder.length);
});
