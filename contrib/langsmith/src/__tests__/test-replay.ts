/**
 * Replay safety: replaying recorded history must not re-emit runs.
 *
 * The plugin's replay-safe run tree suppresses `postRun`/`patchRun` while
 * `workflowInfo().unsafe.isReplayingHistoryEvents` is true, and its sinks are registered with
 * `callDuringReplay: false`. Together these guarantee a pure history replay
 * emits zero LangSmith runs — so the user's observability backend is never
 * flooded with duplicates on replay.
 *
 * @module
 */

import test from 'ava';
import { Worker, type ReplayWorkerOptions } from '@temporalio/worker';

import { LangSmithPlugin } from '../index';
import * as activities from './activities/langsmith';
import { InMemoryRunCollector, WORKFLOWS_PATH, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

process.env.LANGSMITH_TRACING = 'true';

test('replay safety: emits no runs when replaying recorded history', async (t) => {
  const live = new InMemoryRunCollector();
  const history = await withTracingWorker({
    collector: live,
    options: { addTemporalRuns: true },
    activities: { simpleActivity: activities.simpleActivity },
    body: async ({ client, taskQueue }) => {
      const handle = await client.workflow.start(workflows.SimpleWorkflow, {
        taskQueue,
        workflowId: `replay-${Date.now()}`,
        args: ['hi'],
      });
      await handle.result();
      return handle.fetchHistory();
    },
  });

  t.truthy(live.byName('RunWorkflow:SimpleWorkflow'));

  const replay = new InMemoryRunCollector();
  const replayOptions: ReplayWorkerOptions = {
    workflowsPath: WORKFLOWS_PATH,
    plugins: [new LangSmithPlugin({ client: replay.asClient(), addTemporalRuns: true })],
  };
  await Worker.runReplayHistory(replayOptions, history);

  t.deepEqual(replay.records, []);
});
