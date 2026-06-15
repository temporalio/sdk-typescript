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
import { Type } from '@google/genai';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, type ReplayWorkerOptions } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index.js';
import { mockMcpToolset, type MockMcpToolDefinition } from '../testing.js';
import { defaultTestProvider, withWorker, workflowsPath } from './helpers.js';
import { replayScenario } from './workflows.js';

const echoDef: MockMcpToolDefinition = {
  declaration: {
    name: 'echo',
    description: 'Echoes the input value.',
    parameters: {
      type: Type.OBJECT,
      properties: { value: { type: Type.STRING } },
      required: ['value'],
    },
  },
  handler: (args) => ({ echoed: args.value }),
};

function makePlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({
    modelProvider: defaultTestProvider(),
    mcpToolsets: { testServer: mockMcpToolset([echoDef]) },
  });
}

let env: TestWorkflowEnvironment;

test.before(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});

test.after.always(async () => {
  await env?.teardown();
});

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// Replay determinism with plugin (E2E)
test.serial('replayWithPlugin', async (t) => {
  const taskQueue = uid('adk-replay');
  const workflowId = uid('wf-replay');

  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(replayScenario, { taskQueue, workflowId }),
  );
  t.true(result.includes('world'));

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
  t.pass();
});
