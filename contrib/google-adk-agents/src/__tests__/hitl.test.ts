/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E test for human-in-the-loop. Because the ADK agent loop runs in the
 * Workflow body, a `LongRunningFunctionTool.execute` can `await` a Temporal
 * Signal or Update carrying the human's decision. Both variants are exercised.
 */

import test from 'ava';
import { TestWorkflowEnvironment } from '@temporalio/testing';

import { GoogleAdkPlugin } from '../index.js';
import { withWorker } from './helpers.js';
import { approveSignal, approveUpdate, hitlWorkflow } from './workflows.js';

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

// HITL long-running tool (E2E)
test.serial('longRunningToolAwaitsSignal', async (t) => {
  // --- Signal variant ---
  const tq1 = uid('adk-hitl-sig');
  await withWorker(env, { taskQueue: tq1, plugins: [new GoogleAdkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(hitlWorkflow, {
      taskQueue: tq1,
      workflowId: uid('wf-hitl-sig'),
    });
    await handle.signal(approveSignal, 'approved-via-signal');
    t.is(await handle.result(), 'approved-via-signal');
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
    t.is(updateResult, 'approved-via-update');
    t.is(await handle.result(), 'approved-via-update');
  });
});
