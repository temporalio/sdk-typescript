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
import { Context as ActivityContext } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';

import { createMCPActivities } from '../activities';
import { GoogleAdkPlugin } from '../index';
import { mockMCPToolset, type MockMCPResourceDefinition } from '../testing';
import { countScheduledActivities, echoDef, findInCauseChain, setupTestEnv, uid, withWorker } from './helpers';
import { graphTestProvider } from './test-models';
import {
  mcpListResources,
  mcpLoadResourceAgent,
  mcpLoadResourceAgentCancelled,
  mcpLoadResourceAgentFailing,
  mcpReadResource,
} from './graph-workflows';

const stubServerPath = path.resolve(__dirname, 'stub-mcp-server.js');

const README_TEXT = '# Stub\n\nHello from the stub resource.';

const readmeResource: MockMCPResourceDefinition = {
  name: 'readme',
  contents: [{ uri: 'file:///readme.md', mimeType: 'text/markdown', text: README_TEXT }],
};

/** Entries into {@link HangingResourceToolset.readResource} on this worker. */
let hangingReads = 0;

/**
 * Lists `readme` like the mock, but hangs on the read until the Activity's
 * cancellation signal fires and then rejects with an `AbortError`, the way an
 * MCP client honouring the signal does. It reads the signal off the Activity
 * context because ADK's `MCPToolset.readResource(name)` takes none.
 */
class HangingResourceToolset extends BaseToolset {
  constructor() {
    super([]);
  }

  override async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return [];
  }

  async listResources(): Promise<string[]> {
    return [readmeResource.name];
  }

  async readResource(_name: string): Promise<never> {
    hangingReads++;
    const signal = ActivityContext.current().cancellationSignal;
    return new Promise<never>((_resolve, reject) => {
      const abort = (): void => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  override async close(): Promise<void> {}
}

/** Resolves once the hanging read is genuinely in flight, so the cancel lands on a running Activity. */
async function waitForHangingRead(count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (hangingReads < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} hanging reads`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makePlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({
    modelProvider: graphTestProvider(),
    mcpToolsets: {
      testServer: mockMCPToolset([echoDef], { resources: [readmeResource] }),
      brokenServer: () => {
        throw new Error('MCP server unavailable.');
      },
      hangingServer: () => new HangingResourceToolset(),
    },
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

/** The subset of history the retry-bound assertions read. */
type RetryEvent = {
  eventId?: unknown;
  activityTaskScheduledEventAttributes?: { activityType?: { name?: string | null } | null } | null;
  activityTaskStartedEventAttributes?: { scheduledEventId?: unknown; attempt?: number | null } | null;
  activityTaskFailedEventAttributes?: { scheduledEventId?: unknown } | null;
};

/** Event ids of the `ActivityTaskScheduled` events for Activity types starting with `prefix`. */
function scheduledIdsFor(events: RetryEvent[], prefix: string): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.activityTaskScheduledEventAttributes?.activityType?.name?.startsWith(prefix)) {
      ids.add(String(event.eventId));
    }
  }
  return ids;
}

/**
 * The attempt each of those Activities ended on. Temporal writes one
 * `ActivityTaskStarted` per Activity, on its final attempt, so this is the
 * attempt count and not the schedule count.
 */
function finalAttempts(events: RetryEvent[], prefix: string): number[] {
  const scheduled = scheduledIdsFor(events, prefix);
  return events
    .filter((event) => scheduled.has(String(event.activityTaskStartedEventAttributes?.scheduledEventId)))
    .map((event) => event.activityTaskStartedEventAttributes?.attempt ?? 0);
}

function countFailedActivities(events: RetryEvent[], prefix: string): number {
  const scheduled = scheduledIdsFor(events, prefix);
  return events.filter((event) => scheduled.has(String(event.activityTaskFailedEventAttributes?.scheduledEventId)))
    .length;
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

test.serial('a failing server gives up on the default bound, is skipped, and is not memoized', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-res-broken');
  const workflowId = uid('wf-res-broken');
  // The fixture sets no `maximumAttempts`, so this is the default the resource
  // Activities apply. Without it the Activity would retry forever on a
  // status-less MCP error and the turn below would never return.
  const text = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(mcpLoadResourceAgentFailing, { taskQueue, workflowId })
  );
  // The turn completed: neither the listing nor the read failed it.
  t.is(text, 'resource=missing; listed=none');
  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  // Once per model call, because a rejected listing is not the memoized one.
  t.is(countScheduledActivities(events ?? [], 'brokenServer-listResources'), 2);
  t.is(countScheduledActivities(events ?? [], 'brokenServer-readResource'), 1);
  // Each gave up after exactly three attempts, and each ended failed rather than
  // still running.
  t.deepEqual(finalAttempts(events ?? [], 'brokenServer-'), [3, 3, 3]);
  t.is(countFailedActivities(events ?? [], 'brokenServer-'), 3);
});

test.serial('cancelling a hanging read ends the Activity cancelled and re-raises through the tool', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-res-cancel');
  const workflowId = uid('wf-res-cancel');
  const before = hangingReads;
  await withWorker(env, { taskQueue, plugins: [makePlugin()] }, async () => {
    const handle = await env.client.workflow.start(mcpLoadResourceAgentCancelled, { taskQueue, workflowId });
    // Cancel a read that is genuinely in flight, so the Activity really reaches
    // its catch rather than being cancelled before it is dispatched.
    await waitForHangingRead(before + 1);
    await handle.cancel();
    await t.throwsAsync(handle.result());
    // Cancelled, not completed: the tool re-raised instead of logging and
    // skipping, which is what it does for an ordinary read failure.
    t.is((await handle.describe()).status.name, 'CANCELLED');

    const { events } = await handle.fetchHistory();
    t.is(countScheduledActivities(events ?? [], 'hangingServer-readResource'), 1);
    t.true(
      (events ?? []).some((e) => e.activityTaskCanceledEventAttributes != null),
      'expected the read Activity to end cancelled'
    );
    t.false(
      (events ?? []).some((e) => e.activityTaskFailedEventAttributes != null),
      'expected no Activity failure: a cancel must not be classified as an MCP error'
    );
    // A retry would enter the read a second time.
    t.is(hangingReads, before + 1);
  });
});

test('readResource raises the cancellation rather than an MCP failure', async (t) => {
  const activities = createMCPActivities({ hanging: () => new HangingResourceToolset() });
  const readResource = activities['hanging-readResource'] as unknown as (args: { name: string }) => Promise<unknown>;
  const mockEnv = new MockActivityEnvironment();
  mockEnv.cancel();
  const err = await t.throwsAsync(mockEnv.run(readResource, { name: 'readme' }));
  t.true(err instanceof CancelledFailure, `expected a CancelledFailure, got ${err?.constructor.name}`);
  t.false(err instanceof ApplicationFailure);
});

test('listResources raises the cancellation rather than an MCP failure', async (t) => {
  const activities = createMCPActivities({
    hanging: () => {
      const toolset = new HangingResourceToolset();
      // The listing is what hangs here; `readResource` covers the other catch.
      toolset.listResources = () => toolset.readResource('readme');
      return toolset;
    },
  });
  const listResources = activities['hanging-listResources'] as unknown as () => Promise<unknown>;
  const mockEnv = new MockActivityEnvironment();
  mockEnv.cancel();
  const err = await t.throwsAsync(mockEnv.run(listResources));
  t.true(err instanceof CancelledFailure, `expected a CancelledFailure, got ${err?.constructor.name}`);
  t.false(err instanceof ApplicationFailure);
});

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
