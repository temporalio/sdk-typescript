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

import test from 'ava';
import type { LlmResponse } from '@google/adk';
import { TestWorkflowEnvironment } from '@temporalio/testing';

import { GoogleAdkPlugin } from '../index.js';
import { fakeModelProvider } from '../testing.js';
import { withWorker } from './helpers.js';
import { streamingModelCall } from './workflows.js';

const chunks: LlmResponse[] = [
  { content: { role: 'model', parts: [{ text: 'Hello ' }] }, partial: true },
  { content: { role: 'model', parts: [{ text: 'streaming ' }] }, partial: true },
  { content: { role: 'model', parts: [{ text: 'world' }] }, turnComplete: true },
];

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

// Streaming (SSE) model boundary (E2E)
test.serial('streamsPartialResponses', async (t) => {
  const taskQueue = uid('adk-stream');
  const plugin = new GoogleAdkPlugin({ modelProvider: fakeModelProvider(chunks) });
  const result = await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
    env.client.workflow.execute(streamingModelCall, {
      taskQueue,
      workflowId: uid('wf-stream'),
    }),
  );
  t.is(result.chunks, 3);
  t.is(result.text, 'Hello streaming world');
});

test.serial('coalescesChunks', async (t) => {
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
  t.is(result.chunks, 3);
  t.is(result.text, 'Hello streaming world');
});
