/**
 * Replay side-effect counting under forced cache eviction (`maxCachedWorkflows: 0`):
 * asserts each run is emitted exactly once even though every task after the first replays.
 *
 * @module
 */

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, SIMPLE_TREE, dumpTraces, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

process.env.LANGSMITH_TRACING = 'true';

test('replay side effects: emits each run exactly once even when the workflow is evicted and replayed', async (t) => {
  const collector = new InMemoryRunCollector();

  // Count every createRun (including any duplicate a broken replay guard would produce).
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
