/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from 'ava';
import { MCPToolset, type BaseToolset, type MCPConnectionParams } from '@google/adk';
import type { FunctionDeclaration } from '@google/genai';
import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';

import { createMCPActivities } from '../activities';
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

const stubServerPath = path.resolve(__dirname, 'stub-mcp-server.js');

type CallToolActivity = (args: {
  toolName: string;
  args: Record<string, unknown>;
}) => Promise<{ content: unknown; isError?: boolean }>;

function stubServerConnectionParams(log: string): MCPConnectionParams {
  return {
    type: 'StdioConnectionParams',
    serverParams: { command: process.execPath, args: [stubServerPath], env: { MCP_STUB_LOG: log } },
  };
}

function stubServerActivities(log: string): Record<string, (args: never) => Promise<unknown>> {
  return createMCPActivities({ testServer: () => stubServerConnectionParams(log) });
}

function stubServerRecords(log: string): string[] {
  return readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

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

test.serial('doesNotCloseFactorySuppliedToolset', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-mcp-shared');
  const shared = mockMCPToolset([echoDef, reverseDef])() as BaseToolset;
  let closes = 0;
  shared.close = async () => {
    closes += 1;
  };
  const plugin = new GoogleAdkPlugin({ mcpToolsets: { testServer: () => shared } });
  const result = await withWorker(env, { taskQueue, plugins: [plugin] }, () =>
    env.client.workflow.execute(mcpCallTool, {
      taskQueue,
      workflowId: uid('wf-mcp-shared'),
      args: ['hello'],
    })
  );
  t.deepEqual(result, { echoed: 'hello' });
  t.is(closes, 0);
});

test.serial('opensAndClosesOneSessionPerActivityAgainstConnectionParams', async (t) => {
  const log = path.join(os.tmpdir(), `${uid('adk-mcp-sessions')}.log`);
  t.teardown(() => rmSync(log, { force: true }));
  const activities = stubServerActivities(log);
  const mockEnv = new MockActivityEnvironment();

  const declarations: FunctionDeclaration[] = await mockEnv.run(
    activities['testServer-listTools'] as () => Promise<FunctionDeclaration[]>
  );
  t.deepEqual(
    declarations.map((d) => d.name),
    ['echo']
  );

  const result: { content: unknown } = await mockEnv.run(activities['testServer-callTool'] as CallToolActivity, {
    toolName: 'echo',
    args: { value: 'hello' },
  });
  t.deepEqual(result.content, [{ type: 'text', text: '{"echoed":"hello"}' }]);

  t.deepEqual(stubServerRecords(log), ['open', 'tools/list', 'close', 'open', 'tools/call', 'close']);
});

test.serial('opensAndClosesTwoSessionsPerCallToolAgainstBaseToolset', async (t) => {
  const log = path.join(os.tmpdir(), `${uid('adk-mcp-toolset-sessions')}.log`);
  t.teardown(() => rmSync(log, { force: true }));
  const activities = createMCPActivities({ testServer: () => new MCPToolset(stubServerConnectionParams(log)) });

  const result: { content: unknown } = await new MockActivityEnvironment().run(
    activities['testServer-callTool'] as CallToolActivity,
    { toolName: 'echo', args: { value: 'hello' } }
  );
  t.deepEqual(result.content, [{ type: 'text', text: '{"echoed":"hello"}' }]);

  t.deepEqual(stubServerRecords(log), ['open', 'tools/list', 'close', 'open', 'tools/call', 'close']);
});

test.serial('closesToolsetBuiltFromConnectionParams', async (t) => {
  const log = path.join(os.tmpdir(), `${uid('adk-mcp-close')}.log`);
  t.teardown(() => rmSync(log, { force: true }));
  // ADK's own `getTools` closes the session it opens, so even against a real MCP
  // server the plugin's `close()` is observable only as a call.
  const realClose = MCPToolset.prototype.close;
  let closes = 0;
  MCPToolset.prototype.close = async function close(this: MCPToolset) {
    closes += 1;
    return realClose.call(this);
  };
  t.teardown(() => {
    MCPToolset.prototype.close = realClose;
  });

  await new MockActivityEnvironment().run(
    stubServerActivities(log)['testServer-listTools'] as () => Promise<FunctionDeclaration[]>
  );
  t.is(closes, 1);
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

test.serial('unknownToolAgainstConnectionParamsCompletesWithIsError', async (t) => {
  const log = path.join(os.tmpdir(), `${uid('adk-mcp-unknown-params')}.log`);
  t.teardown(() => rmSync(log, { force: true }));
  const result: { content: unknown; isError?: boolean } = await new MockActivityEnvironment().run(
    stubServerActivities(log)['testServer-callTool'] as CallToolActivity,
    { toolName: 'does-not-exist', args: {} }
  );

  t.true(result.isError);
  t.deepEqual(result.content, [{ type: 'text', text: 'MCP error -32602: Tool does-not-exist not found' }]);
  t.deepEqual(stubServerRecords(log), ['open', 'tools/call', 'close']);
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
