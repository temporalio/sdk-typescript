/**
 * Cancellation must survive the Activity catches. The model and MCP Activities
 * classify every error with `toApplicationFailure`, so whatever a client raises
 * once its signal fired has to leave as the cancellation: the Worker reports an
 * Activity as cancelled only when the error leaving it is a `CancelledFailure`
 * or an `AbortError`, and treats anything else as a failure to retry. The real
 * MCP client is the hard case: it wraps the signal's reason in an `McpError`,
 * so the doubles here are joined by the stdio stub server and its `hang` tool.
 */

import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test, { type ExecutionContext } from 'ava';
import {
  BaseTool,
  BaseToolset,
  MCPToolset,
  type MCPConnectionParams,
  type ReadonlyContext,
  type RunAsyncToolRequest,
} from '@google/adk';
import type { FunctionDeclaration } from '@google/genai';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';

import { createMCPActivities, createModelActivities } from '../activities';
import { GoogleAdkPlugin } from '../index';
import type { InvokeModelArgs, WireLlmRequest } from '../model';
import {
  AbortingLlm,
  abortError,
  abortingLlmCallCount,
  countScheduledActivities,
  defaultTestProvider,
  setupTestEnv,
  uid,
  waitForAbortingLlm,
  withWorker,
} from './helpers';
import { cancellableMcpCall, cancellableModelCall } from './workflows';

const getEnv = setupTestEnv(test);

const INVOKE_ARGS: InvokeModelArgs = { model: 'abort-model', request: {} as WireLlmRequest };

type CallToolActivity = (args: { toolName: string; args: Record<string, unknown> }) => Promise<unknown>;

const stubServerPath = path.resolve(__dirname, 'stub-mcp-server.js');

function stubServerConnectionParams(log: string): MCPConnectionParams {
  return {
    type: 'StdioConnectionParams',
    serverParams: { command: process.execPath, args: [stubServerPath], env: { MCP_STUB_LOG: log } },
  };
}

function stubLog(t: ExecutionContext, tag: string): string {
  const log = path.join(os.tmpdir(), `${uid(tag)}.log`);
  t.teardown(() => rmSync(log, { force: true }));
  return log;
}

/**
 * Resolves once the stub server has recorded `entry`, so a cancel lands on a
 * request that is genuinely pending on the server rather than one the client
 * never sent.
 */
async function waitForStubRecord(log: string, entry: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    let records: string[] = [];
    try {
      records = readFileSync(log, 'utf8').split('\n');
    } catch {
      /* the stub has not opened the log yet */
    }
    if (records.includes(entry)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for the stub server to record '${entry}'`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs the `stub-callTool` Activity against the stub's never-replying `hang`
 * tool, cancels it once the server holds the request, and returns what left the
 * Activity. The real MCP client rejects an aborted request with an `McpError`
 * wrapping the signal's reason (`Protocol.request`), the shape the guard must
 * not mistake for a tool failure.
 */
async function cancelHangingStubCall(t: ExecutionContext, factory: (log: string) => MCPConnectionParams | BaseToolset) {
  const log = stubLog(t, 'adk-cancel-mcp');
  const activities = createMCPActivities({ stub: () => factory(log) });
  const callTool = activities['stub-callTool'] as unknown as CallToolActivity;
  const mockEnv = new MockActivityEnvironment();
  const running = mockEnv.run(callTool, { toolName: 'hang', args: {} });
  await waitForStubRecord(log, 'tools/call');
  mockEnv.cancel();
  return await t.throwsAsync(running);
}

/** A tool that rejects with an `AbortError` as soon as its signal is aborted. */
class AbortingTool extends BaseTool {
  constructor() {
    super({ name: 'hang', description: 'Never returns; rejects when aborted.' });
  }

  override _getDeclaration(): FunctionDeclaration {
    return { name: this.name, description: this.description };
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    // The MCP Activity hands the Activity's cancellation signal to the tool.
    const signal = (request.toolContext as unknown as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
    if (!signal) throw new Error('AbortingTool requires an abort signal.');
    return new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  }
}

class AbortingToolset extends BaseToolset {
  constructor() {
    super([]);
  }

  override async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return [new AbortingTool()];
  }

  override async close(): Promise<void> {}
}

test.serial('cancellingAModelCallEndsTheActivityCancelledWithoutRetrying', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-cancel-model');
  const workflowId = uid('wf-cancel-model');
  const before = abortingLlmCallCount();
  await withWorker(
    env,
    { taskQueue, plugins: [new GoogleAdkPlugin({ modelProvider: defaultTestProvider() })] },
    async () => {
      const handle = await env.client.workflow.start(cancellableModelCall, { taskQueue, workflowId });
      // Cancel a model call that is genuinely in flight, so the Activity really
      // reaches the catch rather than being cancelled before it is dispatched.
      await waitForAbortingLlm(before + 1);
      await handle.cancel();
      await t.throwsAsync(handle.result());
      t.is((await handle.describe()).status.name, 'CANCELLED');

      const { events } = await handle.fetchHistory();
      t.is(countScheduledActivities(events ?? [], 'adk-invokeModel'), 1);
      t.true(
        (events ?? []).some((e) => e.activityTaskCanceledEventAttributes != null),
        'expected the model Activity to end cancelled'
      );
      t.false(
        (events ?? []).some((e) => e.activityTaskFailedEventAttributes != null),
        'expected no Activity failure: a cancel must not be classified as a model error'
      );
      // A retry would enter the model a second time.
      t.is(abortingLlmCallCount(), before + 1);
    }
  );
});

test('invokeModelRaisesTheCancellationRatherThanAModelFailure', async (t) => {
  const activities = createModelActivities({ modelProvider: (model) => new AbortingLlm({ model }) });
  const mockEnv = new MockActivityEnvironment();
  mockEnv.cancel();
  const err = await t.throwsAsync(mockEnv.run(activities['adk-invokeModel'], INVOKE_ARGS));
  t.true(err instanceof CancelledFailure, `expected a CancelledFailure, got ${err?.constructor.name}`);
  t.false(err instanceof ApplicationFailure);
});

test('mcpCallToolRaisesTheCancellationRatherThanAnMcpFailure', async (t) => {
  const activities = createMCPActivities({ aborting: () => new AbortingToolset() });
  const callTool = activities['aborting-callTool'] as unknown as CallToolActivity;
  const mockEnv = new MockActivityEnvironment();
  mockEnv.cancel();
  const err = await t.throwsAsync(mockEnv.run(callTool, { toolName: 'hang', args: {} }));
  t.true(err instanceof CancelledFailure, `expected a CancelledFailure, got ${err?.constructor.name}`);
  t.false(err instanceof ApplicationFailure);
});

test('mcpCallToolOverTheRealClientRaisesTheCancellation', async (t) => {
  // Connection-parameters form: the Activity opens its own session.
  const err = await cancelHangingStubCall(t, (log) => stubServerConnectionParams(log));
  t.true(err instanceof CancelledFailure, `expected a CancelledFailure, got ${err?.constructor.name}: ${err?.message}`);
  t.false(err instanceof ApplicationFailure);
});

test('mcpCallToolOnARealMcpToolsetRaisesTheCancellation', async (t) => {
  // Toolset form: ADK's own `MCPTool.runAsync` passes the signal to the client.
  const err = await cancelHangingStubCall(t, (log) => new MCPToolset(stubServerConnectionParams(log)));
  t.true(err instanceof CancelledFailure, `expected a CancelledFailure, got ${err?.constructor.name}: ${err?.message}`);
  t.false(err instanceof ApplicationFailure);
});

test.serial('cancellingAnMcpToolCallEndsTheActivityCancelledWithoutRetrying', async (t) => {
  const env = getEnv();
  const log = stubLog(t, 'adk-cancel-mcp-e2e');
  const taskQueue = uid('adk-cancel-mcp');
  const workflowId = uid('wf-cancel-mcp');
  await withWorker(
    env,
    {
      taskQueue,
      plugins: [
        new GoogleAdkPlugin({
          modelProvider: defaultTestProvider(),
          mcpToolsets: { stub: () => stubServerConnectionParams(log) },
        }),
      ],
    },
    async () => {
      const handle = await env.client.workflow.start(cancellableMcpCall, { taskQueue, workflowId });
      await waitForStubRecord(log, 'tools/call');
      await handle.cancel();
      await t.throwsAsync(handle.result());
      t.is((await handle.describe()).status.name, 'CANCELLED');

      const { events } = await handle.fetchHistory();
      t.is(countScheduledActivities(events ?? [], 'stub-callTool'), 1);
      t.true(
        (events ?? []).some((e) => e.activityTaskCanceledEventAttributes != null),
        'expected the MCP Activity to end cancelled'
      );
      t.false(
        (events ?? []).some((e) => e.activityTaskFailedEventAttributes != null),
        'expected no Activity failure: a cancel the MCP client wrapped must not be classified as an MCP error'
      );
    }
  );
});

test('anAbortErrorWithNoCancelRequestedStaysAModelFailure', async (t) => {
  // The guard keys on the Activity's cancellation signal, not on the error
  // alone: an abort the model raised by itself is still a model failure.
  const activities = createModelActivities({
    modelProvider: () => {
      throw abortError();
    },
  });
  const mockEnv = new MockActivityEnvironment();
  const err = await t.throwsAsync(mockEnv.run(activities['adk-invokeModel'], INVOKE_ARGS));
  t.true(err instanceof ApplicationFailure);
  t.is((err as ApplicationFailure).type, 'GoogleAdkModelError');
});
