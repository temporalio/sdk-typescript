/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * E2E tests for the `TemporalMcpToolset` boundary: tool discovery and tool
 * calls route through named Activities, the FULL `FunctionDeclaration` (incl.
 * parameter schema) round-trips, the named factory resolves on the worker, and
 * `toolFilter` is honored. Uses the in-memory `mockMcpToolset` test double.
 */

import test from 'ava';
import { Type } from '@google/genai';
import { TestWorkflowEnvironment } from '@temporalio/testing';

import { GoogleAdkPlugin } from '../index.js';
import { mockMcpToolset, type MockMcpToolDefinition } from '../testing.js';
import { countScheduledActivities, withWorker } from './helpers.js';
import { mcpCallTool, mcpFilteredTools, mcpListTools } from './workflows.js';

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

const reverseDef: MockMcpToolDefinition = {
  declaration: {
    name: 'reverse',
    description: 'Reverses a string.',
    parameters: {
      type: Type.OBJECT,
      properties: { value: { type: Type.STRING } },
    },
  },
  handler: (args) => ({ reversed: String(args.value).split('').reverse().join('') }),
};

function makePlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({
    mcpToolsets: { testServer: mockMcpToolset([echoDef, reverseDef]) },
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

// TemporalMcpToolset (E2E)
test.serial('listToolsReturnsFullSchema', async (t) => {
  const taskQueue = uid('adk-mcp-list');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(mcpListTools, {
      taskQueue,
      workflowId: uid('wf-mcp-list'),
    }),
  );
  t.is(result.count, 2);
  t.is(result.firstName, 'echo');
  // The model must still see argument schemas, not just names.
  t.is(result.hasParameters, true);
});

test.serial('callToolRoutesToActivity', async (t) => {
  const taskQueue = uid('adk-mcp-call');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(mcpCallTool, {
      taskQueue,
      workflowId: uid('wf-mcp-call'),
      args: ['hello'],
    }),
  );
  t.deepEqual(result, { echoed: 'hello' });
});

test.serial('resolvesNamedToolsetFactory', async (t) => {
  const taskQueue = uid('adk-mcp-named');
  const workflowId = uid('wf-mcp-named');
  await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(mcpListTools, { taskQueue, workflowId }),
  );
  // The toolset name selects a `<name>-listTools` Activity registered by the
  // plugin from the named factory.
  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  t.is(countScheduledActivities(events ?? [], 'testServer-listTools'), 1);
});

test.serial('appliesToolFilter', async (t) => {
  const taskQueue = uid('adk-mcp-filter');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(mcpFilteredTools, {
      taskQueue,
      workflowId: uid('wf-mcp-filter'),
    }),
  );
  // `toolFilter: ['echo']` drops `reverse`.
  t.deepEqual(result, ['echo']);
});
