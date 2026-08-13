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
import {
  bundleWorkflowCode,
  Worker,
  type BundleOptions,
  type BundlerPlugin,
  type WorkerPlugin,
  type WorkflowBundle,
} from '@temporalio/worker';

import { FakeLlm, type MockMCPToolDefinition } from '../testing';

const here = __dirname;

function isSet(env: string | undefined, def: boolean): boolean {
  if (env === undefined) return def;
  env = env.toLocaleLowerCase();
  return env === '1' || env === 't' || env === 'true';
}

/**
 * Mirrors `packages/test`: `REUSE_V8_CONTEXT=false` runs every worker in
 * per-workflow-VM mode instead of the default reusable-V8-context mode, so the
 * polyfill loader and telemetry gating get coverage in both sandbox modes.
 */
export const REUSE_V8_CONTEXT = isSet(process.env.REUSE_V8_CONTEXT, true);

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

// The test workflows are bundled from their TypeScript source. `here` is
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
    abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    // Both model Activities pass the Activity's cancellation signal; honoring it ends an attempt
    // abandoned by the start-to-close timeout at once, not 10s later.
    await new Promise<void>((resolve) => {
      if (abortSignal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 10_000);
      abortSignal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
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
  plugins: Array<WorkerPlugin & BundlerPlugin>;
  activities?: object;
  maxCachedWorkflows?: number;
  /**
   * User workflow-interceptor modules to bundle; the plugin's polyfill loader
   * still evaluates first, these follow.
   */
  workflowInterceptorModules?: string[];
}

const bundleCache = new Map<string, Promise<WorkflowBundle>>();

/**
 * Bundles the Workflow sandbox for `options`, reusing an earlier compile of an identical bundle — and a
 * wrong hit silently runs a case against another's bundle. The key holds the plugin names plus every
 * *resolved* `BundleOptions` field that shapes the bundle except `webpackConfigHook`, which is a
 * function and can't be serialized (`logger` is left out too; it only routes webpack's output). So state
 * that reaches a keyed field needs nothing extra, but a plugin that bakes its constructor config into
 * the bundle through the hook — e.g. as `DefinePlugin` definitions — must add that state to the key.
 * `configureBundler` runs twice per miss (here, then in the bundler), so it must also be pure.
 */
function getWorkflowBundle(
  options: Pick<BundleOptions, 'workflowsPath' | 'workflowInterceptorModules' | 'plugins'>
): Promise<WorkflowBundle> {
  const plugins = options.plugins ?? [];
  const resolved = plugins.reduce<BundleOptions>((acc, plugin) => plugin.configureBundler?.(acc) ?? acc, options);
  const key = JSON.stringify([
    plugins.map((plugin) => plugin.name),
    resolved.workflowsPath,
    resolved.workflowInterceptorModules ?? null,
    resolved.payloadConverterPath ?? null,
    resolved.failureConverterPath ?? null,
    resolved.ignoreModules ?? null,
    resolved.preloadModules ?? null,
  ]);
  let bundle = bundleCache.get(key);
  if (bundle === undefined) {
    // Bundle from the caller's options, not the resolved ones: `bundleWorkflowCode` runs the
    // plugin chain itself, so resolved options would apply it twice — a second `addSandboxCompat`
    // wrapper installs a second copy of the sandbox-compat webpack plugin and pins the
    // `@opentelemetry/api` alias again.
    bundle = bundleWorkflowCode(options);
    // Cache the promise, not the awaited bundle, so a second caller joins an in-flight compile; drop a
    // rejected one so later tests recompile instead of inheriting the cached rejection.
    bundleCache.set(key, bundle);
    bundle.catch(() => bundleCache.delete(key));
  }
  return bundle;
}

/**
 * Boots a worker against `env`, runs `fn` while it polls, then shuts it down.
 */
export async function withWorker<T>(
  env: TestWorkflowEnvironment,
  options: WithWorkerOptions,
  fn: () => Promise<T>
): Promise<T> {
  // `Worker.create` ignores `interceptors.workflowModules` once `workflowBundle` is set, so the
  // modules go to the bundler; the WARN a composed plugin triggers there is benign.
  const workflowBundle = await getWorkflowBundle({
    workflowsPath,
    workflowInterceptorModules: options.workflowInterceptorModules,
    plugins: options.plugins,
  });
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: options.taskQueue,
    workflowBundle,
    reuseV8Context: REUSE_V8_CONTEXT,
    plugins: options.plugins,
    activities: options.activities,
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
