/**
 * Replay determinism. Runs scenarios to produce real histories, then replays
 * them with the plugin registered. ADK's event ids / timestamps funnel through
 * `Math.random()` / `Date.now()`, which the Workflow sandbox makes
 * deterministic, and ADK 2.0's UUIDs (interrupt ids, function-call ids) through
 * the plugin's named-random-stream `crypto` shim — so replay must succeed
 * without a custom determinism hook. A determinism violation rejects
 * `Worker.runReplayHistory`.
 *
 * Besides replaying freshly recorded histories, the graph and HITL scenarios are
 * replayed from histories checked in under `histories/`, so a change to ADK's
 * or the plugin's command stream is caught against a frozen recording. Refresh
 * them with `UPDATE_ADK_HISTORIES=1 pnpm test`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import test from 'ava';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, type ReplayWorkerOptions } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index';
import { mockMCPToolset } from '../testing';
import {
  defaultTestProvider,
  echoDef,
  REUSE_V8_CONTEXT,
  setupTestEnv,
  uid,
  withWorker,
  workflowsPath,
} from './helpers';
import * as activities from './test-activities';
import { graphTestProvider } from './test-models';
import { graphSequential, hitlInputNode, pendingHitlQuery, respondHitlUpdate } from './graph-workflows';
import { replayScenario } from './workflows';

const historiesDir = path.resolve(__dirname, '../../src/__tests__/histories');
const UPDATE_HISTORIES = process.env.UPDATE_ADK_HISTORIES === '1';

function makePlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({
    modelProvider: graphTestProvider(),
    mcpToolsets: { testServer: mockMCPToolset([echoDef]) },
  });
}

function replayOptions(): ReplayWorkerOptions {
  return { workflowsPath, reuseV8Context: REUSE_V8_CONTEXT, plugins: [makePlugin()] };
}

const getEnv = setupTestEnv(test);

// Replay determinism with plugin (E2E)
test.serial('replayWithPlugin', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-replay');
  const workflowId = uid('wf-replay');
  const plugin = new GoogleAdkPlugin({
    modelProvider: defaultTestProvider(),
    mcpToolsets: { testServer: mockMCPToolset([echoDef]) },
  });

  const liveResult = await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
    env.client.workflow.execute(replayScenario, { taskQueue, workflowId })
  );
  t.true(liveResult.includes('world'));

  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();

  // Replay the recorded history with the plugin registered (not just the
  // workflows). Resolves on success; rejects on a determinism violation.
  // `plugins` is a first-class `ReplayWorkerOptions` field (it is not in the
  // `Omit` list that derives the type from `WorkerOptions`, and
  // `Worker.runReplayHistory` invokes each plugin's `configureBundler`),
  // and `GoogleAdkPlugin` is a `WorkerPlugin` via `SimplePlugin` — so this is
  // fully type-checked, no cast.
  await Worker.runReplayHistory(replayOptions(), history);

  // `runReplayHistory` only verifies the command stream, not the workflow's
  // return value. Re-run the scenario with the workflow cache disabled
  // (`maxCachedWorkflows: 0`) so every workflow task replays the full history;
  // the result it produces must deep-equal the live run's.
  const replayTaskQueue = uid('adk-replay-nocache');
  const replayedResult = await withWorker(
    env,
    { taskQueue: replayTaskQueue, plugins: [plugin], maxCachedWorkflows: 0 },
    () =>
      env.client.workflow.execute(replayScenario, {
        taskQueue: replayTaskQueue,
        workflowId: uid('wf-replay-nocache'),
      })
  );
  t.deepEqual(replayedResult, liveResult);
});

/** Runs the graph scenario live and returns its history. */
async function recordGraphHistory(env: TestWorkflowEnvironment) {
  const taskQueue = uid('adk-replay-graph');
  const workflowId = uid('wf-replay-graph');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(graphSequential, { taskQueue, workflowId, args: ['replay'] })
  );
  if (result.output !== 'data-for-replay summarized')
    throw new Error(`unexpected graph result ${JSON.stringify(result)}`);
  return env.client.workflow.getHandle(workflowId).fetchHistory();
}

/** Runs the HITL scenario live — pause, answer through the Update, resume — and returns its history. */
async function recordHitlHistory(env: TestWorkflowEnvironment) {
  const taskQueue = uid('adk-replay-hitl');
  const workflowId = uid('wf-replay-hitl');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlInputNode, { taskQueue, workflowId });
    const deadline = Date.now() + 20_000;
    while ((await handle.query(pendingHitlQuery)).length === 0) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the HITL pause');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await handle.executeUpdate(respondHitlUpdate, { args: ['approval', 'ship-it'] });
    const result = await handle.result();
    if (result.output !== 'approved:ship-it') throw new Error(`unexpected HITL result ${JSON.stringify(result)}`);
  });
  return env.client.workflow.getHandle(workflowId).fetchHistory();
}

const RECORDED: Array<{ file: string; record: (env: TestWorkflowEnvironment) => Promise<unknown> }> = [
  { file: 'graph_workflow.json', record: recordGraphHistory },
  { file: 'hitl_workflow.json', record: recordHitlHistory },
];

for (const { file, record } of RECORDED) {
  // Graph / HITL histories replay live and from the checked-in fixture (E2E)
  test.serial(`replays ${file} live and from the checked-in fixture`, async (t) => {
    const env = getEnv();
    const fixture = path.join(historiesDir, file);

    const live = await record(env);
    await Worker.runReplayHistory(replayOptions(), live);

    if (UPDATE_HISTORIES) {
      writeFileSync(fixture, historyToJSON(live as Parameters<typeof historyToJSON>[0]));
      t.log(`re-recorded ${fixture}`);
    }
    // `runReplayHistory` accepts the JSON form and converts it itself.
    const recorded: unknown = JSON.parse(readFileSync(fixture, 'utf8'));
    await t.notThrowsAsync(Worker.runReplayHistory(replayOptions(), recorded), `replaying ${file}`);
  });
}
