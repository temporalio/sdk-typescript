/**
 * Replay safety: replaying recorded history must not re-emit runs.
 *
 * The plugin's replay-safe run tree suppresses `postRun`/`patchRun` while
 * `workflowInfo().unsafe.isReplaying` is true, and its sinks are registered with
 * `callDuringReplay: false`. Together these guarantee a pure history replay
 * emits zero LangSmith runs — so the user's observability backend is never
 * flooded with duplicates on replay.
 *
 * This boots a real environment to record a `SimpleWorkflow` history, then
 * replays that history through a fresh plugin + collector and asserts nothing
 * was emitted.
 *
 * @module
 */

process.env.LANGSMITH_TRACING = 'true';

import { Worker, type ReplayWorkerOptions } from '@temporalio/worker';
import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, WORKFLOWS_PATH, withTracingWorker } from './helpers';
import { LangSmithPlugin } from '../index';
import * as workflows from './workflows/langsmith';

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

  // Sanity: the live run actually produced the workflow span we will replay.
  t.truthy(live.byName('RunWorkflow:SimpleWorkflow'));

  // Pass the plugin through the *typed* replay entry point — `ReplayWorkerOptions`
  // inherits `plugins` from `WorkerOptions`, so no cast is needed. This proves
  // the replay worker accepts (and applies) the plugin the same way
  // `Worker.create` does; the live run above emitted `RunWorkflow:` under the
  // identical plugin config, so the empty replay result below is genuine
  // suppression, not a silently-dropped plugin.
  const replay = new InMemoryRunCollector();
  const replayOptions: ReplayWorkerOptions = {
    workflowsPath: WORKFLOWS_PATH,
    plugins: [new LangSmithPlugin({ client: replay.asClient(), addTemporalRuns: true })],
  };
  await Worker.runReplayHistory(replayOptions, history);

  t.deepEqual(replay.records, []);
});
