/**
 * Shared E2E test scaffolding: a local Temporal test environment, a worker
 * factory that wires the plugin, model test doubles, and a history helper.
 */

import path from 'node:path';

import type { TestFn } from 'ava';
import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import { Type } from '@google/genai';
import { defaultPayloadConverter } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import { FakeLlm, type MockMCPToolDefinition } from '../testing.js';

const here = __dirname;

/** A unique task-queue / workflow id. */
export function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Registers `test.before` / `test.after` hooks that boot and tear down a local
 * Temporal test environment for the calling test file (ava is
 * process-per-file). Returns an accessor for the booted environment.
 */
export function setupTestEnv(test: TestFn): () => TestWorkflowEnvironment {
  let env: TestWorkflowEnvironment;
  test.before(async () => {
    env = await TestWorkflowEnvironment.createLocal();
  });
  test.after.always(async () => {
    await env?.teardown();
  });
  return () => env;
}

/** An `echo` MCP tool double, with a full parameter schema. */
export const echoDef: MockMCPToolDefinition = {
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

/** A `reverse` MCP tool double. */
export const reverseDef: MockMCPToolDefinition = {
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

// The Worker bundles the test workflows from their TypeScript source. `here` is
// `lib/__tests__` at runtime, so resolve back to the `src/__tests__` source that
// ships alongside it.
/** Absolute path to the test workflows source bundled into the sandbox. */
export const workflowsPath = path.resolve(here, '../../src/__tests__/workflows.ts');

/** A model that always raises a non-retryable (HTTP 400) error. */
export class ThrowingLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = ['boom'];

  // eslint-disable-next-line require-yield -- a model double that always throws before yielding
  override async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal
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
    _abortSignal?: AbortSignal
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
    return new FakeLlm({ model, responses });
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
  fn: () => Promise<T>
): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: options.taskQueue,
    workflowsPath,
    plugins: options.plugins as any,
    activities: options.activities as any,
    maxCachedWorkflows: options.maxCachedWorkflows,
  });
  return worker.runUntil(fn());
}

/** Counts `ActivityTaskScheduled` history events by activity type name. */
export function countScheduledActivities(
  events: Array<{ activityTaskScheduledEventAttributes?: { activityType?: { name?: string | null } | null } | null }>,
  activityTypeName: string
): number {
  return events.filter((e) => e.activityTaskScheduledEventAttributes?.activityType?.name === activityTypeName).length;
}

/**
 * Reads the decoded `summary` of the first `ActivityTaskScheduled` event with
 * the given activity type name, or `undefined` if none carries one.
 */
export function getScheduledActivitySummary(
  events: Array<{
    activityTaskScheduledEventAttributes?: { activityType?: { name?: string | null } | null } | null;
    userMetadata?: { summary?: unknown } | null;
  }>,
  activityTypeName: string
): string | undefined {
  const scheduled = events.find((e) => e.activityTaskScheduledEventAttributes?.activityType?.name === activityTypeName);
  const payload = scheduled?.userMetadata?.summary;
  if (payload == null) return undefined;
  return defaultPayloadConverter.fromPayload(payload as never);
}

/**
 * Walks the `.cause` chain of a thrown error looking for the first instance of
 * `ctor`. Temporal nests failures (`WorkflowFailedError` → `ActivityFailure` →
 * `ApplicationFailure` / `TimeoutFailure`), so tests use this to assert on the
 * underlying typed failure regardless of nesting depth.
 */
export function findInCauseChain<T>(err: unknown, ctor: new (...args: any[]) => T): T | undefined {
  let current: unknown = err;
  while (current) {
    if (current instanceof ctor) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
