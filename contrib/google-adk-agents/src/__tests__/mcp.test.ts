/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E tests for the `TemporalMCPToolset` boundary: tool discovery and tool
 * calls route through the named server's Activities, the FULL
 * `FunctionDeclaration` (incl. parameter schema) round-trips, and `toolFilter`
 * / `prefix` shape the advertised tool names. Uses the in-memory
 * `mockMCPToolset` test double.
 */

import test from 'ava';
import { ApplicationFailure } from '@temporalio/common';

import { GoogleAdkPlugin } from '../index';
import { TemporalMCPToolset } from '../workflow';
import { mockMCPToolset } from '../testing';
import {
  echoDef,
  findInCauseChain,
  getScheduledActivitySummary,
  reverseDef,
  setupTestEnv,
  uid,
  withWorker,
} from './helpers';
import {
  mcpCallTool,
  mcpCallToolWithActivitySummary,
  mcpCallUnknownTool,
  mcpListTools,
  mcpToolNameVariants,
} from './workflows';

function makePlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({
    mcpToolsets: { testServer: mockMCPToolset([echoDef, reverseDef]) },
  });
}

const getEnv = setupTestEnv(test);

// TemporalMCPToolset (E2E)
test.serial('listToolsReturnsFullSchema', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-mcp-list');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(mcpListTools, {
      taskQueue,
      workflowId: uid('wf-mcp-list'),
    })
  );
  t.is(result.count, 2);
  t.is(result.firstName, 'echo');
  // The model must still see argument schemas, not just names.
  t.is(result.hasParameters, true);
});

test.serial('callToolRoutesToActivity', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-mcp-call');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(mcpCallTool, {
      taskQueue,
      workflowId: uid('wf-mcp-call'),
      args: ['hello'],
    })
  );
  t.deepEqual(result, { echoed: 'hello' });
});

test.serial('unknownToolFailsNonRetryably', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-mcp-unknown');
  await withWorker(env, { taskQueue, plugins: [makePlugin()] }, async () => {
    const handle = await env.client.workflow.start(mcpCallUnknownTool, {
      taskQueue,
      workflowId: uid('wf-mcp-unknown'),
    });
    let caught: unknown;
    try {
      await handle.result();
    } catch (err) {
      caught = err;
    }
    const appFailure = findInCauseChain(caught, ApplicationFailure);
    t.not(appFailure, undefined);
    t.is(appFailure?.type, 'GoogleAdkMCPToolNotFound');
    t.is(appFailure?.nonRetryable, true);
  });
});

test.serial('respectsCallerActivitySummary', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-mcp-summary');
  const workflowId = uid('wf-mcp-summary');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(mcpCallToolWithActivitySummary, {
      taskQueue,
      workflowId,
      args: ['hello'],
    })
  );
  t.deepEqual(result, { echoed: 'hello' });

  // A caller-supplied `activity.summary` must not be clobbered by the
  // auto-generated per-activity labels on either MCP activity.
  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  t.is(getScheduledActivitySummary(events ?? [], 'testServer-listTools'), 'mcp-activity-summary');
  t.is(getScheduledActivitySummary(events ?? [], 'testServer-callTool'), 'mcp-activity-summary');
});

test.serial('shapesAdvertisedToolNamesByFilterAndPrefix', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-mcp-names');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(mcpToolNameVariants, {
      taskQueue,
      workflowId: uid('wf-mcp-names'),
    })
  );
  // `toolFilter: ['echo']` drops `reverse`.
  t.deepEqual(result.filtered, ['echo']);
  t.deepEqual(result.prefixed, ['srv_echo', 'srv_reverse']);
  // With both set, the filter matches the *advertised* (post-prefix) name —
  // ADK `MCPToolset` semantics, so `['echo']` here would match nothing.
  t.deepEqual(result.both, ['srv_echo']);
});

// TemporalMCPToolset outside a Workflow
test('getToolsOutsideWorkflowRequiresConnectionParams', async (t) => {
  const toolset = new TemporalMCPToolset({ name: 'noParams' });
  const err = await t.throwsAsync(toolset.getTools());
  t.true(err instanceof ApplicationFailure);
  t.is((err as ApplicationFailure).type, 'GoogleAdkMCPToolsetOutsideWorkflow');
  t.is((err as ApplicationFailure).nonRetryable, true);
});
