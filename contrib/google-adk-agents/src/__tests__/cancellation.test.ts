/**
 * Cancellation must survive the Activity catches. The model and MCP Activities
 * classify every error with `toApplicationFailure`, so an `AbortError` raised by
 * a client whose signal fired has to be let through untouched: the Worker
 * reports an Activity as cancelled only when the error leaving it is a
 * `CancelledFailure` or an `AbortError`, and treats anything else as a failure
 * to retry.
 */

import test from 'ava';
import { BaseTool, BaseToolset, type ReadonlyContext, type RunAsyncToolRequest } from '@google/adk';
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
import { cancellableModelCall } from './workflows';

const getEnv = setupTestEnv(test);

const INVOKE_ARGS: InvokeModelArgs = { model: 'abort-model', request: {} as WireLlmRequest };

type CallToolActivity = (args: { toolName: string; args: Record<string, unknown> }) => Promise<unknown>;

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
