/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Replay determinism. Runs a combined scenario (two model calls + an MCP
 * discovery + call) to produce a real history, then replays that history with
 * the plugin registered. ADK's event IDs / timestamps funnel through
 * `Math.random()` / `Date.now()`, which the Workflow sandbox makes
 * deterministic — so replay must succeed without a custom determinism hook. A
 * determinism violation rejects `Worker.runReplayHistory`.
 */

import test from 'ava';
import { Worker, type ReplayWorkerOptions } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index.js';
import { mockMCPToolset } from '../testing.js';
import { defaultTestProvider, echoDef, setupTestEnv, uid, withWorker, workflowsPath } from './helpers.js';
import { replayScenario } from './workflows.js';

function makePlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({
    modelProvider: defaultTestProvider(),
    mcpToolsets: { testServer: mockMCPToolset([echoDef]) },
  });
}

const getEnv = setupTestEnv(test);

// Replay determinism with plugin (E2E)
test.serial('replayWithPlugin', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-replay');
  const workflowId = uid('wf-replay');

  const liveResult = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
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
  const replayOptions: ReplayWorkerOptions = {
    workflowsPath,
    plugins: [makePlugin()],
  };
  await Worker.runReplayHistory(replayOptions, history);

  // `runReplayHistory` only verifies the command stream, not the workflow's
  // return value. Re-run the scenario with the workflow cache disabled
  // (`maxCachedWorkflows: 0`) so every workflow task replays the full history;
  // the result it produces must deep-equal the live run's.
  const replayTaskQueue = uid('adk-replay-nocache');
  const replayedResult = await withWorker(
    env,
    { taskQueue: replayTaskQueue, plugins: [makePlugin()], maxCachedWorkflows: 0 },
    () =>
      env.client.workflow.execute(replayScenario, {
        taskQueue: replayTaskQueue,
        workflowId: uid('wf-replay-nocache'),
      })
  );
  t.deepEqual(replayedResult, liveResult);
});
