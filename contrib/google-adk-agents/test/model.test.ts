/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E tests for the `TemporalLlm` model boundary. Each test boots a local
 * Temporal server + worker (with the plugin), runs a real ADK `TemporalLlm`
 * inside the Workflow, and asserts on observable behavior (return values,
 * scheduled-activity counts, typed failures, activity summaries).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  ApplicationFailure,
  defaultPayloadConverter,
  TimeoutFailure,
} from '@temporalio/common';
import { LLMRegistry, type LlmRequest } from '@google/adk';

import { GoogleAdkPlugin, TemporalLlm } from '../src/index.js';
import { FakeLlm, fakeModelProvider } from '../src/testing.js';
import {
  countScheduledActivities,
  defaultTestProvider,
  findInCauseChain,
  withWorker,
} from './helpers.js';
import {
  countModelCalls,
  modelCallError,
  modelCallWithSummary,
  modelCallWithTimeout,
  singleModelCall,
} from './workflows.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env?.teardown();
});

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

describe('TemporalLlm model boundary (E2E)', () => {
  it('routesGenerateContentToActivity', async () => {
    const taskQueue = uid('adk-route');
    const plugin = new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
    const result = await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
      env.client.workflow.execute(singleModelCall, {
        taskQueue,
        workflowId: uid('wf-route'),
        args: ['hello'],
      }),
    );
    // FakeLlm's default response text encodes the resolved model name, proving
    // the model call was actually dispatched through the activity boundary.
    expect(result).toBe('fake-response:fake-model');
  });

  it('sideEffectsActivityCount', async () => {
    const taskQueue = uid('adk-count');
    const workflowId = uid('wf-count');
    const n = 3;
    const plugin = new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
    // Cache size 0 forces full replay each task, so the scheduled-activity
    // count reflects exactly one Activity per model call (no caching artifacts).
    const result = await withWorker(
      env,
      { taskQueue, plugins: [plugin], maxCachedWorkflows: 0 },
      () =>
        env.client.workflow.execute(countModelCalls, {
          taskQueue,
          workflowId,
          args: [n],
        }),
    );
    expect(result).toBe(n);

    const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
    expect(countScheduledActivities(events ?? [], 'invokeModel')).toBe(n);
  });

  it('usesCustomModelProvider', async () => {
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
      }),
    );
    // Only reachable if the activity used the plugin's `modelProvider`.
    expect(result).toBe('CUSTOM-PROVIDER-OUTPUT');
  });

  it('appliesActivitySummary', async () => {
    const taskQueue = uid('adk-summary');
    const workflowId = uid('wf-summary');
    const plugin = new GoogleAdkPlugin({ modelProvider: defaultTestProvider() });
    await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
      env.client.workflow.execute(modelCallWithSummary, {
        taskQueue,
        workflowId,
        args: ['hi'],
      }),
    );

    const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
    const scheduled = (events ?? []).find(
      (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'invokeModel',
    );
    const summaryPayload = (scheduled as { userMetadata?: { summary?: unknown } } | undefined)
      ?.userMetadata?.summary;
    expect(summaryPayload).toBeDefined();
    const summary = defaultPayloadConverter.fromPayload(summaryPayload as never);
    expect(summary).toBe('custom-model-summary');
  });

  it('modelErrorPropagatesAsApplicationFailure', async () => {
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
      expect(appFailure).toBeDefined();
      // HTTP 400 → non-retryable, typed by status (never string-matched).
      expect(appFailure?.type).toBe('GoogleAdkModelError.400');
      expect(appFailure?.nonRetryable).toBe(true);
    });
  });

  it('appliesActivityTimeout', async () => {
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
      expect(timeout).toBeDefined();
    });
  });
});

describe('TemporalLlm outside a Workflow', () => {
  it('delegatesWhenNotInWorkflow', async () => {
    // Outside a Workflow, `TemporalLlm` resolves and delegates to the real
    // registered model — no worker, no activity boundary.
    LLMRegistry.register(FakeLlm);
    const llm = new TemporalLlm('fake-model');
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
    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0]?.text).toBe('fake-response:fake-model');
  });
});
