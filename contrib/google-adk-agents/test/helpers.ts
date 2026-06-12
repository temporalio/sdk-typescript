/**
 * Shared E2E test scaffolding: a local Temporal test environment, a worker
 * factory that wires the plugin, model test doubles, and a history helper.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import { FakeLlm } from '../src/testing.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the test workflows bundle. */
export const workflowsPath = path.join(here, 'workflows.ts');

/** A model that always raises a non-retryable (HTTP 400) error. */
export class ThrowingLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = ['boom'];

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    throw Object.assign(new Error('bad request'), { status: 400 });
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ThrowingLlm does not connect.');
  }
}

/** A model that sleeps long enough to blow a short `startToCloseTimeout`. */
export class SlowLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = ['slow-model'];

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    yield { content: { role: 'model', parts: [{ text: 'too late' }] }, turnComplete: true };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('SlowLlm does not connect.');
  }
}

/**
 * A `modelProvider` that maps `boom` → {@link ThrowingLlm}, `slow-model` →
 * {@link SlowLlm}, and everything else → {@link FakeLlm} (optionally with
 * canned responses).
 */
export function defaultTestProvider(responses?: LlmResponse[]): (model: string) => BaseLlm {
  return (model: string): BaseLlm => {
    if (model === 'boom') return new ThrowingLlm({ model });
    if (model === 'slow-model') return new SlowLlm({ model });
    return new FakeLlm({ model }, responses);
  };
}

/** Options for {@link withWorker}. */
export interface WithWorkerOptions {
  taskQueue: string;
  // Plugins are passed to the Worker only (never also to the Client) so the
  // plugin's activities are registered exactly once.
  plugins: unknown[];
  activities?: Record<string, (...args: never[]) => Promise<unknown>>;
  maxCachedWorkflows?: number;
}

/**
 * Boots a worker against `env`, runs `fn` while it polls, then shuts it down.
 */
export async function withWorker<T>(
  env: TestWorkflowEnvironment,
  options: WithWorkerOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: options.taskQueue,
    workflowsPath,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: options.plugins as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activities: options.activities as any,
    maxCachedWorkflows: options.maxCachedWorkflows,
  });
  return worker.runUntil(fn());
}

/** Counts `ActivityTaskScheduled` history events by activity type name. */
export function countScheduledActivities(
  events: Array<{ activityTaskScheduledEventAttributes?: { activityType?: { name?: string | null } | null } | null }>,
  activityTypeName: string,
): number {
  return events.filter(
    (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === activityTypeName,
  ).length;
}

/**
 * Walks the `.cause` chain of a thrown error looking for the first instance of
 * `ctor`. Temporal nests failures (`WorkflowFailedError` → `ActivityFailure` →
 * `ApplicationFailure` / `TimeoutFailure`), so tests use this to assert on the
 * underlying typed failure regardless of nesting depth.
 */
export function findInCauseChain<T>(
  err: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...args: any[]) => T,
): T | undefined {
  let current: unknown = err;
  while (current) {
    if (current instanceof ctor) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
