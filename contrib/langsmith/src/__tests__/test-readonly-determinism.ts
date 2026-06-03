/**
 * Read-only handlers must not perturb the Workflow's main PRNG: a perturbed draw
 * would change a replayed command and surface as a determinism violation.
 *
 * @module
 */

import test from 'ava';

import { Worker } from '@temporalio/worker';

import { LangSmithPlugin } from '../index';
import { InMemoryRunCollector, WORKFLOWS_PATH, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

process.env.LANGSMITH_TRACING = 'true';

test('read-only handlers do not perturb the main random sequence', async (t) => {
  const collector = new InMemoryRunCollector();
  const options = { addTemporalRuns: true };

  await withTracingWorker({
    collector,
    options,
    activities: {},
    // A live cache (>0) retains the validator's PRNG perturbation; 0 would evict-and-replay and mask it.
    workerOptions: { maxCachedWorkflows: 2 },
    body: async ({ client, taskQueue }) => {
      const handle = await client.workflow.start(workflows.ReadonlyDeterminismWorkflow, {
        taskQueue,
        workflowId: `readonly-determinism-${Date.now()}`,
      });

      // The always-rejecting validator runs the read-only path on the live cached instance, then fails.
      await t.throwsAsync(handle.executeUpdate(workflows.readonlyUpdate, { args: ['x'] }));

      await handle.signal(workflows.releaseSignal);
      await handle.result();
      const history = await handle.fetchHistory();

      // Replay before teardown so the live Runtime singleton is reused (replaying after it shuts down races native finalization).
      const plugin = new LangSmithPlugin({ ...options, client: new InMemoryRunCollector().asClient() });
      await Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH, plugins: [plugin] }, history);

      t.pass();
    },
  });
});
