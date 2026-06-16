/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E tests for the `TemporalModel` model boundary. Each test boots a local
 * Temporal server + worker (with the plugin), runs a real ADK `TemporalModel`
 * inside the Workflow, and asserts on observable behavior (return values,
 * scheduled-activity counts, typed failures, activity summaries).
 */

import test from 'ava';
import { LLMRegistry, type LlmRequest } from '@google/adk';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { ApplicationFailure, defaultPayloadConverter, TimeoutFailure } from '@temporalio/common';

import { GoogleAdkPlugin, TemporalModel } from '../index.js';
import { FakeLlm, fakeModelProvider } from '../testing.js';
import { countScheduledActivities, defaultTestProvider, findInCauseChain, withWorker } from './helpers.js';
import {
  agentRunnerWorkflow,
  countModelCalls,
  modelCallError,
  modelCallWithSummary,
  modelCallWithTimeout,
  singleModelCall,
  streamingModelCallNoTopic,
} from './workflows.js';

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

// TemporalModel model boundary (E2E)
test.serial('routesGenerateContentToActivity', async (t) => {
  const taskQueue = uid('adk-route');
  const plugin = new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
  const result = await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
    env.client.workflow.execute(singleModelCall, {
      taskQueue,
      workflowId: uid('wf-route'),
      args: ['hello'],
    })
  );
  // FakeLlm's default response text encodes the resolved model name, proving
  // the model call was actually dispatched through the activity boundary.
  t.is(result, 'fake-response:fake-model');
});

test.serial('sideEffectsActivityCount', async (t) => {
  const taskQueue = uid('adk-count');
  const workflowId = uid('wf-count');
  const n = 3;
  const plugin = new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
  // Cache size 0 forces full replay each task, so the scheduled-activity
  // count reflects exactly one Activity per model call (no caching artifacts).
  const result = await withWorker(env, { taskQueue, plugins: [plugin], maxCachedWorkflows: 0 }, () =>
    env.client.workflow.execute(countModelCalls, {
      taskQueue,
      workflowId,
      args: [n],
    })
  );
  t.is(result, n);

  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  t.is(countScheduledActivities(events ?? [], 'invokeModel'), n);
});

test.serial('usesCustomModelProvider', async (t) => {
  const taskQueue = uid('adk-custom');
  const plugin = new GoogleAdkPlugin({
    modelProvider: fakeModelProvider([
      {
        content: { role: 'model', parts: [{ text: 'CUSTOM-PROVIDER-OUTPUT' }] },
        turnComplete: true,
      },
    ]),
  });
  const result = await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
    env.client.workflow.execute(singleModelCall, {
      taskQueue,
      workflowId: uid('wf-custom'),
      args: ['hi'],
    })
  );
  // Only reachable if the activity used the plugin's `modelProvider`.
  t.is(result, 'CUSTOM-PROVIDER-OUTPUT');
});

test.serial('appliesActivitySummary', async (t) => {
  const taskQueue = uid('adk-summary');
  const workflowId = uid('wf-summary');
  const plugin = new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
  await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
    env.client.workflow.execute(modelCallWithSummary, {
      taskQueue,
      workflowId,
      args: ['hi'],
    })
  );

  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  const scheduled = (events ?? []).find(
    (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'invokeModel'
  );
  const summaryPayload = (scheduled as { userMetadata?: { summary?: unknown } } | undefined)?.userMetadata?.summary;
  t.not(summaryPayload, undefined);
  const summary = defaultPayloadConverter.fromPayload(summaryPayload as never);
  t.is(summary, 'custom-model-summary');
});

test.serial('defaultsActivitySummaryToAgentName', async (t) => {
  const taskQueue = uid('adk-summary-agent');
  const workflowId = uid('wf-summary-agent');
  const plugin = new GoogleAdkPlugin({ modelProvider: fakeModelProvider() });
  await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
    env.client.workflow.execute(agentRunnerWorkflow, {
      taskQueue,
      workflowId,
      args: ['hi'],
    })
  );

  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  const scheduled = (events ?? []).find(
    (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'invokeModel'
  );
  const summaryPayload = (scheduled as { userMetadata?: { summary?: unknown } } | undefined)?.userMetadata?.summary;
  t.not(summaryPayload, undefined);
  const summary = defaultPayloadConverter.fromPayload(summaryPayload as never);
  // No explicit `summary`; the runner stamps `adk_agent_name` = the agent name.
  t.is(summary, 'assistant');
});

test.serial('modelErrorPropagatesAsApplicationFailure', async (t) => {
  const taskQueue = uid('adk-error');
  const plugin = new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
  await withWorker(env, { taskQueue, plugins: [plugin] }, async () => {
    const handle = await env.client.workflow.start(modelCallError, {
      taskQueue,
      workflowId: uid('wf-error'),
    });
    let caught: unknown;
    try {
      await handle.result();
    } catch (err) {
      caught = err;
    }
    const appFailure = findInCauseChain(caught, ApplicationFailure);
    t.not(appFailure, undefined);
    // HTTP 400 → non-retryable, typed by status (never string-matched).
    t.is(appFailure?.type, 'GoogleAdkModelError.400');
    t.is(appFailure?.nonRetryable, true);
  });
});

test.serial('streamingWithoutTopicFails', async (t) => {
  const taskQueue = uid('adk-stream-notopic');
  const plugin = new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
  await withWorker(env, { taskQueue, plugins: [plugin] }, async () => {
    const handle = await env.client.workflow.start(streamingModelCallNoTopic, {
      taskQueue,
      workflowId: uid('wf-stream-notopic'),
    });
    let caught: unknown;
    try {
      await handle.result();
    } catch (err) {
      caught = err;
    }
    // Streaming requested with no `streamingTopic` must throw, not fall back.
    const appFailure = findInCauseChain(caught, ApplicationFailure);
    t.not(appFailure, undefined);
    t.is(appFailure?.type, 'GoogleAdkStreamingTopicRequired');
    t.is(appFailure?.nonRetryable, true);
    t.regex(appFailure?.message ?? '', /streamingTopic/);
  });
});

test.serial('appliesActivityTimeout', async (t) => {
  const taskQueue = uid('adk-timeout');
  const plugin = new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
  await withWorker(env, { taskQueue, plugins: [plugin] }, async () => {
    const handle = await env.client.workflow.start(modelCallWithTimeout, {
      taskQueue,
      workflowId: uid('wf-timeout'),
    });
    let caught: unknown;
    try {
      await handle.result();
    } catch (err) {
      caught = err;
    }
    // The slow model blows the 1s `startToCloseTimeout`; with maximumAttempts
    // 1 the Workflow fails with a TimeoutFailure in the cause chain.
    const timeout = findInCauseChain(caught, TimeoutFailure);
    t.not(timeout, undefined);
  });
});

// TemporalModel outside a Workflow
test.serial('delegatesWhenNotInWorkflow', async (t) => {
  // Outside a Workflow, `TemporalModel` resolves and delegates to the real
  // registered model — no worker, no activity boundary.
  LLMRegistry.register(FakeLlm);
  const llm = new TemporalModel('fake-model');
  const request = {
    model: 'fake-model',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    config: {},
    toolsDict: {},
    liveConnectConfig: {},
  } as LlmRequest;

  const responses: Array<{ content?: { parts?: Array<{ text?: string }> } }> = [];
  for await (const r of llm.generateContentAsync(request)) {
    responses.push(r);
  }
  t.is(responses.length, 1);
  t.is(responses[0]?.content?.parts?.[0]?.text, 'fake-response:fake-model');
});
