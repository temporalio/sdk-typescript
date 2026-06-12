/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E test for human-in-the-loop. Because the ADK agent loop runs in the
 * Workflow body, a `LongRunningFunctionTool.execute` can `await` a Temporal
 * Signal or Update carrying the human's decision. Both variants are exercised.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';

import { GoogleAdkPlugin } from '../src/index.js';
import { withWorker } from './helpers.js';
import { approveSignal, approveUpdate, hitlWorkflow } from './workflows.js';

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

describe('HITL long-running tool (E2E)', () => {
  it('longRunningToolAwaitsSignal', async () => {
    // --- Signal variant ---
    const tq1 = uid('adk-hitl-sig');
    await withWorker(env, { taskQueue: tq1, plugins: [new GoogleAdkPlugin()] }, async () => {
      const handle = await env.client.workflow.start(hitlWorkflow, {
        taskQueue: tq1,
        workflowId: uid('wf-hitl-sig'),
      });
      await handle.signal(approveSignal, 'approved-via-signal');
      expect(await handle.result()).toBe('approved-via-signal');
    });

    // --- Update variant (same handler, request/response) ---
    const tq2 = uid('adk-hitl-upd');
    await withWorker(env, { taskQueue: tq2, plugins: [new GoogleAdkPlugin()] }, async () => {
      const handle = await env.client.workflow.start(hitlWorkflow, {
        taskQueue: tq2,
        workflowId: uid('wf-hitl-upd'),
      });
      const updateResult = await handle.executeUpdate(approveUpdate, {
        args: ['approved-via-update'],
      });
      expect(updateResult).toBe('approved-via-update');
      expect(await handle.result()).toBe('approved-via-update');
    });
  });
});
