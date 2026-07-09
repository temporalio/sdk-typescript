/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E tests for SSE streaming. With `streamingTopic` set, a streamed model call
 * publishes incremental `LlmResponse` chunks via `@temporalio/workflow-streams`
 * while the Workflow still receives the full, ordered transcript via the
 * Activity result (the deterministic, replay-safe channel).
 */

import test from 'ava';
import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';

import { createModelActivities } from '../activities.js';
import { GoogleAdkPlugin } from '../index.js';
import { fakeModelProvider } from '../testing.js';
import { setupTestEnv, uid, withWorker } from './helpers.js';
import { closeStream, streamingModelCall, streamingModelCallSubscribed } from './workflows.js';

const chunks: LlmResponse[] = [
  { content: { role: 'model', parts: [{ text: 'Hello ' }] }, partial: true },
  { content: { role: 'model', parts: [{ text: 'streaming ' }] }, partial: true },
  { content: { role: 'model', parts: [{ text: 'world' }] }, turnComplete: true },
];

const getEnv = setupTestEnv(test);

// Streaming (SSE) model boundary (E2E)
test.serial('streamsPartialResponses', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-stream');
  const plugin = new GoogleAdkPlugin({ modelProvider: fakeModelProvider(chunks) });
  const result = await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
    env.client.workflow.execute(streamingModelCall, {
      taskQueue,
      workflowId: uid('wf-stream'),
    })
  );
  t.is(result.chunks, 3);
  t.is(result.text, 'Hello streaming world');
});

// E2E over the side-channel itself: subscribe to the stream topic and assert
// the published chunks — not just the transcript returned to the Workflow.
test.serial('publishesChunksToStreamTopic', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-stream-topic');
  const plugin = new GoogleAdkPlugin({ modelProvider: fakeModelProvider(chunks) });
  await withWorker(env, { taskQueue, plugins: [plugin] }, async () => {
    const handle = await env.client.workflow.start(streamingModelCallSubscribed, {
      taskQueue,
      workflowId: uid('wf-stream-topic'),
      args: ['500 milliseconds'],
    });

    const streamClient = new WorkflowStreamClient(handle);
    const published: LlmResponse[] = [];
    const gen = streamClient.subscribe<LlmResponse>('adk-test-stream', 0, { pollCooldown: 0, resultType: true });
    for await (const item of gen) {
      published.push(item.data);
      if (published.length >= chunks.length) {
        await gen.return();
        break;
      }
    }
    await handle.signal(closeStream);
    const result = await handle.result();

    t.is(result.chunks, 3);
    t.is(result.text, 'Hello streaming world');
    t.deepEqual(
      published.map((r) => r.content?.parts?.[0]?.text),
      ['Hello ', 'streaming ', 'world']
    );
  });
});

/** A model that yields one chunk, then raises a retryable (HTTP 503) error. */
class MidStreamThrowingLlm extends BaseLlm {
  override async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    yield { content: { role: 'model', parts: [{ text: 'partial ' }] }, partial: true };
    throw Object.assign(new Error('mid-stream failure'), { status: 503 });
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('MidStreamThrowingLlm does not connect.');
  }
}

// Unit test (MockActivityEnvironment): when the model throws mid-stream, the
// surfaced failure must be the classified model error — a rejection from the
// stream's dispose must not mask it — and the stream must still be disposed.
test.serial('midStreamModelErrorIsClassifiedAndStreamDisposed', async (t) => {
  const original = WorkflowStreamClient.fromWithinActivity;
  let disposed = false;
  let published = 0;
  WorkflowStreamClient.fromWithinActivity = (() => ({
    topic: () => ({
      publish: () => {
        published++;
      },
    }),
    [Symbol.asyncDispose]: async () => {
      disposed = true;
      throw new Error('dispose failed');
    },
  })) as unknown as typeof WorkflowStreamClient.fromWithinActivity;
  try {
    const activities = createModelActivities({
      modelProvider: (model) => new MidStreamThrowingLlm({ model }),
    });
    const mockEnv = new MockActivityEnvironment();
    const err = await t.throwsAsync(
      mockEnv.run(activities.invokeModelStreaming, {
        model: 'mid-stream',
        request: {} as never,
        streamingTopic: 'adk-test-stream',
      })
    );
    t.true(err instanceof ApplicationFailure, `expected ApplicationFailure, got: ${err}`);
    t.is((err as ApplicationFailure).type, 'GoogleAdkModelError.503');
    t.true(disposed);
    t.is(published, 1);
  } finally {
    WorkflowStreamClient.fromWithinActivity = original;
  }
});
