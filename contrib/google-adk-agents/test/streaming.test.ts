/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E tests for SSE streaming. With `streamingTopic` set, a streamed model call
 * publishes incremental `LlmResponse` chunks via `@temporalio/workflow-streams`
 * while the Workflow still receives the full, ordered transcript via the
 * Activity result (the deterministic, replay-safe channel asserted here).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { LlmResponse } from '@google/adk';

import { GoogleAdkPlugin } from '../src/index.js';
import { fakeModelProvider } from '../src/testing.js';
import { withWorker } from './helpers.js';
import { streamingModelCall } from './workflows.js';

const chunks: LlmResponse[] = [
  { content: { role: 'model', parts: [{ text: 'Hello ' }] }, partial: true },
  { content: { role: 'model', parts: [{ text: 'streaming ' }] }, partial: true },
  { content: { role: 'model', parts: [{ text: 'world' }] }, turnComplete: true },
];

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

describe('Streaming (SSE) model boundary (E2E)', () => {
  it('streamsPartialResponses', async () => {
    const taskQueue = uid('adk-stream');
    const plugin = new GoogleAdkPlugin({ modelProvider: fakeModelProvider(chunks) });
    const result = await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
      env.client.workflow.execute(streamingModelCall, {
        taskQueue,
        workflowId: uid('wf-stream'),
      }),
    );
    expect(result.chunks).toBe(3);
    expect(result.text).toBe('Hello streaming world');
  });

  it('coalescesChunks', async () => {
    // A larger batch interval coalesces the streamed side-channel; the Workflow
    // still receives every chunk, in order, via the Activity result.
    const taskQueue = uid('adk-stream-coalesce');
    const plugin = new GoogleAdkPlugin({ modelProvider: fakeModelProvider(chunks) });
    const result = await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
      env.client.workflow.execute(streamingModelCall, {
        taskQueue,
        workflowId: uid('wf-stream-coalesce'),
        args: ['500 milliseconds'],
      }),
    );
    expect(result.chunks).toBe(3);
    expect(result.text).toBe('Hello streaming world');
  });
});
