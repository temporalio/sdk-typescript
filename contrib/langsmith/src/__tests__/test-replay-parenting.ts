/**
 * Replay determinism of `traceable` parenting under the SDK-provided
 * `AsyncLocalStorage`. Trace context inside the workflow isolate now rides the
 * runtime-injected real ALS instead of a synchronous stack, so the risk is that
 * async-context propagation resolves a different parent on replay. These cases
 * exercise the three shapes most sensitive to that — nested `traceable`,
 * `Promise.all` fan-out, and an async-generator (LangSmith's
 * `AsyncLocalStorage.snapshot()` path) — and assert the emitted run hierarchy
 * (parent links) is stable across replay.
 *
 * Determinism is proven two ways:
 *  1. `maxCachedWorkflows: 0` evicts after every task, forcing the workflow body
 *     to re-execute from history on each task. A divergent parent resolution on
 *     replay would surface as a different tree or a duplicate `createRun`.
 *  2. A true `Worker.runReplayHistory` pass must emit nothing (recorded history
 *     re-emits no runs).
 *
 * @module
 */

import test from 'ava';
import { Worker } from '@temporalio/worker';

import { LangSmithPlugin } from '../index';
import { InMemoryRunCollector, WORKFLOWS_PATH, dumpTraces, withTracingWorker } from './helpers';
import {
  ConcurrentTraceableWorkflow,
  NestedTraceableWorkflow,
  StreamingTraceableWorkflow,
} from './workflows/langsmith';

process.env.LANGSMITH_TRACING = 'true';
// Keep langsmith callbacks synchronous so a stray/duplicate run fails fast.
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';

/**
 * Run `workflow` under forced eviction (every task after the first replays the
 * body from history), then replay the recorded history. Asserts:
 *  - the live tree matches `expectedTree`;
 *  - every run was created exactly once (no duplicate from a divergent replay);
 *  - a pure history replay re-emits nothing.
 */
async function assertParentingStable(
  t: import('ava').ExecutionContext,
  workflow: typeof NestedTraceableWorkflow | typeof ConcurrentTraceableWorkflow | typeof StreamingTraceableWorkflow,
  workflowId: string,
  expectedTree: string
): Promise<void> {
  const collector = new InMemoryRunCollector();
  let rawCreate = 0;
  const inner = collector.createRun;
  collector.createRun = async (run: Record<string, unknown>): Promise<void> => {
    rawCreate += 1;
    return inner(run);
  };

  await withTracingWorker({
    collector,
    options: { addTemporalRuns: false },
    activities: {},
    // Evict after every task so each subsequent task replays the body from history.
    workerOptions: { maxCachedWorkflows: 0 },
    body: async ({ client, taskQueue }) => {
      const handle = await client.workflow.start(workflow, {
        taskQueue,
        workflowId: `${workflowId}-${Date.now()}`,
        args: ['x'],
      });
      await handle.result();
      const history = await handle.fetchHistory();

      t.is(dumpTraces(collector.records), expectedTree, 'live tree matches expected parenting');
      t.is(rawCreate, collector.createOrder.length, 'each run created exactly once across evict-and-replay');

      // Replay before teardown so the live Runtime singleton is reused (replaying after
      // it shuts down races native finalization).
      const replay = new InMemoryRunCollector();
      const plugin = new LangSmithPlugin({ client: replay.asClient(), addTemporalRuns: false });
      await Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH, plugins: [plugin] }, history);
      t.deepEqual(replay.records, [], 'pure history replay re-emits nothing');
    },
  });
}

test('nested traceable: child nests under its enclosing traceable, stable across replay', async (t) => {
  await assertParentingStable(t, NestedTraceableWorkflow, 'nested', ['parent', '  leaf'].join('\n'));
});

test('Promise.all fan-out: each concurrent traceable parents under the workflow run, stable across replay', async (t) => {
  await assertParentingStable(t, ConcurrentTraceableWorkflow, 'concurrent', ['fanout', 'fanout', 'fanout'].join('\n'));
});

test('async-generator traceable: streaming run parents deterministically, stable across replay', async (t) => {
  await assertParentingStable(t, StreamingTraceableWorkflow, 'streaming', 'streaming');
});
