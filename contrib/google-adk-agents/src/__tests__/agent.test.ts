/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Native-runtime integration test — the load-bearing proof that an existing
 * ADK agent becomes durable with no rewrite. A vanilla `LlmAgent` is driven by
 * the SDK's own `InMemoryRunner.runEphemeral` loop inside a Workflow; the only
 * change from plain ADK is the one-line `model: new TemporalLlm(...)` swap plus
 * registering `GoogleAdkPlugin` on the worker. The agent's loop runs
 * deterministically in the Workflow while each model turn becomes an Activity.
 */

import test from 'ava';
import { TestWorkflowEnvironment } from '@temporalio/testing';

import { GoogleAdkPlugin } from '../index.js';
import { fakeModelProvider } from '../testing.js';
import { countScheduledActivities, withWorker } from './helpers.js';
import { agentRunnerWorkflow } from './workflows.js';

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

// Native ADK Runner integration (E2E)
test.serial('runsLlmAgentThroughRunnerWithDurableModelCalls', async (t) => {
  const taskQueue = uid('adk-agent');
  const workflowId = uid('wf-agent');
  const plugin = new GoogleAdkPlugin({ modelProvider: fakeModelProvider() });

  // Cache size 0 forces a full replay each task, so the scheduled-activity
  // count below reflects exactly the model turns the native runner made.
  const result = await withWorker(
    env,
    { taskQueue, plugins: [plugin], maxCachedWorkflows: 0 },
    () =>
      env.client.workflow.execute(agentRunnerWorkflow, {
        taskQueue,
        workflowId,
        args: ['What is durable execution?'],
      }),
  );

  // The native `InMemoryRunner` surfaced the model's final text, proving the
  // whole agent loop ran to completion inside the Workflow.
  t.is(result, 'fake-response:fake-model');

  // ...and that final text came from a durable Activity: the `LlmAgent`'s
  // single model turn routed through `invokeModel` exactly once.
  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  t.is(countScheduledActivities(events ?? [], 'invokeModel'), 1);
});
