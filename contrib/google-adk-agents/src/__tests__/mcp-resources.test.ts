/**
 * ADK 2.0 MCP resources through the plugin: `TemporalMCPToolset.listResources` /
 * `readResource` and the two-phase `loadMcpResourceTool`, against the in-memory
 * mock and the stdio stub server.
 */

import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from 'ava';
import { BaseToolset, type BaseTool, type MCPConnectionParams, type ReadonlyContext } from '@google/adk';
import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';

import { createMCPActivities } from '../activities';
import { GoogleAdkPlugin } from '../index';
import { mockMCPToolset, type MockMCPResourceDefinition } from '../testing';
import { countScheduledActivities, echoDef, findInCauseChain, setupTestEnv, uid, withWorker } from './helpers';
import { graphTestProvider } from './test-models';
import { mcpListResources, mcpLoadResourceAgent, mcpReadResource } from './graph-workflows';

const stubServerPath = path.resolve(__dirname, 'stub-mcp-server.js');

const README_TEXT = '# Stub\n\nHello from the stub resource.';

const readmeResource: MockMCPResourceDefinition = {
  name: 'readme',
  contents: [{ uri: 'file:///readme.md', mimeType: 'text/markdown', text: README_TEXT }],
};

function makePlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({
    modelProvider: graphTestProvider(),
    mcpToolsets: { testServer: mockMCPToolset([echoDef], { resources: [readmeResource] }) },
  });
}

function stubServerConnectionParams(log: string): MCPConnectionParams {
  return {
    type: 'StdioConnectionParams',
    serverParams: { command: process.execPath, args: [stubServerPath], env: { MCP_STUB_LOG: log } },
  };
}

function stubServerRecords(log: string): string[] {
  return readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

const getEnv = setupTestEnv(test);

test.serial('listResources and readResource route through the resource Activities', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-res-list');
  const listId = uid('wf-res-list');
  const readId = uid('wf-res-read');
  await withWorker(env, { taskQueue, plugins: [makePlugin()] }, async () => {
    t.deepEqual(await env.client.workflow.execute(mcpListResources, { taskQueue, workflowId: listId }), ['readme']);
    t.deepEqual(
      await env.client.workflow.execute(mcpReadResource, { taskQueue, workflowId: readId, args: ['readme'] }),
      readmeResource.contents
    );
  });
  const { events: listEvents } = await env.client.workflow.getHandle(listId).fetchHistory();
  t.is(countScheduledActivities(listEvents ?? [], 'testServer-listResources'), 1);
  const { events: readEvents } = await env.client.workflow.getHandle(readId).fetchHistory();
  t.is(countScheduledActivities(readEvents ?? [], 'testServer-readResource'), 1);
});

test.serial('an unknown resource fails as an MCP error', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-res-unknown');
  const err = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    t.throwsAsync(
      env.client.workflow.execute(mcpReadResource, { taskQueue, workflowId: uid('wf-res-unknown'), args: ['nope'] })
    )
  );
  const failure = findInCauseChain(err, ApplicationFailure);
  t.is(failure?.type, 'GoogleAdkMCPError');
  t.regex(failure?.message ?? '', /Resource with name 'nope' not found/);
});

test.serial('a factory-supplied toolset without resource methods fails non-retryably', async (t) => {
  class PlainToolset extends BaseToolset {
    constructor() {
      super([]);
    }
    override async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
      return [];
    }
    override async close(): Promise<void> {}
  }
  const activities = createMCPActivities({ plain: () => new PlainToolset() });
  const err = await t.throwsAsync(
    new MockActivityEnvironment().run(activities['plain-listResources'] as () => Promise<string[]>)
  );
  t.true(err instanceof ApplicationFailure);
  t.is((err as ApplicationFailure).type, 'GoogleAdkMCPResourcesUnsupported');
  t.is((err as ApplicationFailure).nonRetryable, true);
});

test.serial('against connection params, listing uses one session and reading one more', async (t) => {
  const log = path.join(os.tmpdir(), `${uid('adk-res-sessions')}.log`);
  t.teardown(() => rmSync(log, { force: true }));
  const activities = createMCPActivities({ testServer: () => stubServerConnectionParams(log) });
  const mockEnv = new MockActivityEnvironment();

  const names: string[] = await mockEnv.run(activities['testServer-listResources'] as () => Promise<string[]>);
  t.deepEqual(names, ['readme']);

  const contents = (await mockEnv.run(
    activities['testServer-readResource'] as (args: { name: string }) => Promise<Array<{ text?: string }>>,
    { name: 'readme' }
  )) as Array<{ text?: string }>;
  t.is(contents[0]?.text, README_TEXT);

  // The read resolves the name to a URI and reads it over the SAME session (ADK's
  // own `MCPToolset.readResource` opens two).
  t.deepEqual(stubServerRecords(log), [
    'open',
    'resources/list',
    'close',
    'open',
    'resources/list',
    'resources/read',
    'close',
  ]);
});

test.serial(
  'loadMcpResourceTool appends the requested resource on the next turn and memoizes the listing',
  async (t) => {
    const env = getEnv();
    const taskQueue = uid('adk-res-tool');
    const workflowId = uid('wf-res-tool');
    const texts = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
      env.client.workflow.execute(mcpLoadResourceAgent, { taskQueue, workflowId, args: [2] })
    );
    // Turn 1: the model asked for `readme`, the tool answered with the "call again"
    // status, and ADK appended the resource's contents to the model's next request.
    t.is(texts[0], `resource=${README_TEXT}; listed=["readme"]`);
    // Turn 2: as the tool's status says, the contents were "temporarily inserted and
    // removed" — they were appended to that one request, not to the session — so a
    // turn that does not ask again sees only the instruction listing the resources.
    t.is(texts[1], `resource=missing; listed=["readme"]`);
    const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
    t.is(countScheduledActivities(events ?? [], 'testServer-readResource'), 1);
    // One listing for the tool instance's lifetime, across every model call of both turns.
    t.is(countScheduledActivities(events ?? [], 'testServer-listResources'), 1);
  }
);

test.serial('refreshResourceList re-lists the resources on every model call', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-res-refresh');
  const workflowId = uid('wf-res-refresh');
  await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(mcpLoadResourceAgent, { taskQueue, workflowId, args: [1, true] })
  );
  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  const modelCalls = countScheduledActivities(events ?? [], 'adk-invokeModel');
  t.true(modelCalls >= 2);
  t.is(countScheduledActivities(events ?? [], 'testServer-listResources'), modelCalls);
});
