/**
 * {@link LangSmithPlugin} — the single object a user adds to their Temporal
 * `Client` and `Worker` to get LangSmith tracing across workflow / activity /
 * child-workflow / Nexus boundaries with no changes to their existing
 * `traceable` instrumentation.
 *
 * The plugin wires four things:
 *  1. a **client interceptor** that propagates trace context out of any
 *     `start` / `signal` / `query` / `update` call;
 *  2. **activity + Nexus inbound interceptors** that reconstruct the trace and
 *     install it as the active run (so body `traceable` calls nest correctly);
 *  3. the **workflow interceptor module** (loaded into the workflow bundle) plus
 *     a bundle-time global carrying the plugin config; and
 *  4. the **LangSmith sink** that performs the actual out-of-isolate emission.
 *
 * On worker shutdown it flushes the LangSmith client so in-flight traces are
 * not lost.
 *
 * @module
 */

import { Client } from 'langsmith';

import { createActivityInboundInterceptor, createNexusInboundInterceptor } from './activity-interceptor';
import { createClientInterceptor } from './client-interceptor';
import { createLangSmithSinks } from './sinks';
import type { EmitterConfig } from './sinks';
import type { WorkflowLangSmithConfig } from './workflow-interceptors';

// The base class merges the values returned by each `configure*` hook into the
// downstream Client / Worker / bundler options, and drives `runWorker`.
import { SimplePlugin } from '@temporalio/plugin';
import type { ClientOptions } from '@temporalio/client';
import type {
  BundleOptions,
  ReplayWorkerOptions,
  Worker,
  WorkerInterceptors,
  WorkerOptions,
} from '@temporalio/worker';

/**
 * The webpack `Configuration` type as the SDK's bundler hook sees it. Derived
 * from {@link BundleOptions} rather than imported directly: `@temporalio/worker`
 * re-exports `WebpackConfiguration` from its options module but not from the
 * package root, so deriving it keeps us off a non-public import path.
 */
type WebpackConfiguration = Parameters<NonNullable<BundleOptions['webpackConfigHook']>>[0];

/**
 * The module specifier for the workflow-side interceptors. The worker's
 * bundler resolves this to load the deterministic context provider and the
 * workflow inbound/outbound interceptors into the V8 isolate.
 */
const WORKFLOW_INTERCEPTOR_MODULE = '@temporalio/langsmith/workflow-interceptors';

/**
 * Name under which the bundler injects the plugin config as a bare global into
 * the workflow bundle. Declared as a bare identifier (not a dotted property) so
 * webpack's `DefinePlugin` performs a clean textual substitution — the dotted
 * form is a well-known footgun that silently fails to replace.
 */
const CONFIG_GLOBAL = '__TEMPORAL_LANGSMITH_CONFIG__';

/**
 * The bare builtin name (no `node:` prefix) added to `BundleOptions.ignoreModules`
 * so the SDK bundler's disallowed-module guard does not abort the build. The
 * guard slices the `node:` prefix before matching, so the bare name is what it
 * compares against. See {@link LangSmithPlugin.configureBundler}.
 */
const ASYNC_HOOKS_MODULE = 'async_hooks';

/**
 * Options for {@link LangSmithPlugin}.
 *
 * Secrets (the LangSmith API key) are never accepted here as plaintext and
 * never cross a Temporal boundary — supply a pre-constructed {@link Client}
 * (which reads `LANGSMITH_API_KEY` from the worker/client process env) or let
 * the plugin construct a default client from the environment.
 */
export interface LangSmithPluginOptions {
  /**
   * The LangSmith client runs are emitted to. Defaults to `new Client()`, which
   * reads `LANGSMITH_API_KEY` / `LANGSMITH_ENDPOINT` from the process
   * environment. Lives only in the worker/client process — never serialized.
   */
  client?: Client;
  /** Target LangSmith project for every emitted run. */
  projectName?: string;
  /**
   * When `true`, emit first-class runs for Temporal operations themselves
   * (`StartWorkflow:`, `RunActivity:`, `HandleSignal:`, …) in addition to the
   * user's `traceable` runs. When `false` (default), only the user's
   * `traceable` runs are emitted — trace context still propagates across
   * boundaries so they nest correctly. Mirrors the Python plugin's
   * `add_temporal_runs`.
   */
  addTemporalRuns?: boolean;
  /** Tags attached to every run the plugin emits. */
  defaultTags?: string[];
  /** Metadata merged into every run the plugin emits (credential keys scrubbed). */
  defaultMetadata?: Record<string, unknown>;
}

/**
 * Temporal plugin that adds LangSmith observability to a Client + Worker.
 *
 * @example
 * ```ts
 * import { traceable } from 'langsmith/traceable';
 * import { LangSmithPlugin } from '@temporalio/langsmith';
 *
 * const plugin = new LangSmithPlugin({ addTemporalRuns: true });
 * const worker = await Worker.create({ workflowsPath, taskQueue: 'tq', plugins: [plugin] });
 * ```
 */
export class LangSmithPlugin extends SimplePlugin {
  private readonly client: Client;
  private readonly emitter: EmitterConfig;
  private readonly workflowConfig: WorkflowLangSmithConfig;
  private readonly configJson: string;

  constructor(options: LangSmithPluginOptions = {}) {
    // The plugin name is carried by the base class (LangSmith Cloud groups
    // telemetry by this string). It MUST be passed through `super(...)`: the
    // base constructor reads `options.name` immediately, so a `readonly name`
    // field initializer — which runs only *after* `super()` returns — would
    // leave the base reading `undefined.name` and throw.
    super({ name: 'langsmith.LangSmithPlugin' });
    this.client = options.client ?? new Client();
    const addTemporalRuns = options.addTemporalRuns ?? false;
    this.emitter = {
      client: this.client,
      addTemporalRuns,
      projectName: options.projectName,
      defaultTags: options.defaultTags,
      defaultMetadata: options.defaultMetadata,
    };
    this.workflowConfig = {
      addTemporalRuns,
      projectName: options.projectName,
      defaultTags: options.defaultTags,
      defaultMetadata: options.defaultMetadata,
    };
    this.configJson = JSON.stringify(this.workflowConfig);
  }

  /**
   * Register the client interceptor that propagates trace context outbound.
   * Delegates to the base merge first, then appends our workflow client
   * interceptor onto whatever the user / base already configured.
   */
  override configureClient(options: ClientOptions): ClientOptions {
    const base = super.configureClient(options);
    const existing = base.interceptors ?? {};
    const workflow = Array.isArray(existing.workflow) ? [...existing.workflow] : [];
    workflow.push(createClientInterceptor(this.emitter) as unknown as (typeof workflow)[number]);
    return { ...base, interceptors: { ...existing, workflow } };
  }

  /** Register activity + Nexus inbound interceptors, the workflow module, and the sink. */
  override configureWorker(options: WorkerOptions): WorkerOptions {
    return this.withLangSmithWorker(super.configureWorker(options));
  }

  /** Replay workers need the same workflow interceptors + sinks as live workers. */
  override configureReplayWorker(options: ReplayWorkerOptions): ReplayWorkerOptions {
    return this.withLangSmithWorker(super.configureReplayWorker(options));
  }

  /**
   * Layer the LangSmith activity/Nexus inbound interceptors, the workflow
   * interceptor module, and the emission sink onto an already-merged worker
   * options object. Shared by {@link configureWorker} and
   * {@link configureReplayWorker} so live and replay workers stay in lockstep.
   */
  private withLangSmithWorker<T extends WorkerOptions | ReplayWorkerOptions>(options: T): T {
    const interceptors: WorkerInterceptors = options.interceptors ?? {};

    const activityInbound = [...(interceptors.activityInbound ?? [])];
    activityInbound.push(
      createActivityInboundInterceptor(this.emitter) as unknown as (typeof activityInbound)[number],
    );

    const workflowModules = [...(interceptors.workflowModules ?? [])];
    if (!workflowModules.includes(WORKFLOW_INTERCEPTOR_MODULE)) {
      workflowModules.push(WORKFLOW_INTERCEPTOR_MODULE);
    }

    const nexusInbound = createNexusInboundInterceptor(this.emitter);
    const nexus = [...(interceptors.nexus ?? [])];
    nexus.push(
      ((_ctx: unknown) => ({ inbound: nexusInbound })) as unknown as (typeof nexus)[number],
    );

    // Merge our sink without clobbering any sink the user already configured.
    const sinks = { ...(options.sinks ?? {}), ...createLangSmithSinks(this.client) };

    return {
      ...options,
      interceptors: { ...interceptors, activityInbound, workflowModules, nexus },
      sinks,
    } as T;
  }

  /**
   * Register the workflow interceptor module and inject the plugin config into
   * the workflow bundle as a bare global via webpack's `DefinePlugin`.
   */
  override configureBundler(options: BundleOptions): BundleOptions {
    const base = super.configureBundler(options);
    const workflowInterceptorModules = [...(base.workflowInterceptorModules ?? [])];
    if (!workflowInterceptorModules.includes(WORKFLOW_INTERCEPTOR_MODULE)) {
      workflowInterceptorModules.push(WORKFLOW_INTERCEPTOR_MODULE);
    }
    // A user workflow body that imports `langsmith/traceable` transitively
    // imports `node:async_hooks` (langsmith does `import { AsyncLocalStorage }
    // from "node:async_hooks"` at module load). The SDK bundler's
    // `captureProblematicModules` guard reads the *original* dependency request
    // (`node:async_hooks`, independent of our webpack rewrite below), strips the
    // `node:` prefix, and aborts the build because `async_hooks` is a disallowed
    // builtin. Whitelisting `async_hooks` in `ignoreModules` is the SDK-sanctioned
    // way to dismiss that guard (it is the exact remedy the error message names).
    // This is safe *because* the rewrite below replaces the module with our
    // deterministic, isolate-safe `AsyncLocalStorage` shim — the disallowed
    // Node implementation never actually reaches the isolate.
    const ignoreModules = [...(base.ignoreModules ?? [])];
    if (!ignoreModules.includes(ASYNC_HOOKS_MODULE)) {
      ignoreModules.push(ASYNC_HOOKS_MODULE);
    }
    const prevHook = base.webpackConfigHook;
    const configJson = this.configJson;
    const webpackConfigHook = (config: WebpackConfiguration): WebpackConfiguration => {
      const merged = prevHook ? prevHook(config) : config;
      // `JSON.stringify(JSON.stringify(x))` so the injected token is a string
      // literal in the bundle, parsed back by the workflow module at runtime.
      const definitions = { [CONFIG_GLOBAL]: JSON.stringify(configJson) };
      const withDefine = injectDefinePlugin(merged, definitions);
      // `node:async_hooks` does not exist in the V8 isolate, yet a user workflow
      // body that imports `langsmith/traceable` drags it in (langsmith does
      // `import { AsyncLocalStorage } from "node:async_hooks"` and runs
      // `new AsyncLocalStorage()` at module load). Without this alias webpack
      // fails the build with `UnhandledSchemeError`. Redirect the import to the
      // workflow interceptor module's isolate-safe `AsyncLocalStorage` shim,
      // which is backed by the same deterministic context manager the
      // interceptors use — this is what lets a native `traceable` call inside a
      // workflow body nest under the workflow run with no user code changes.
      return aliasAsyncHooks(withDefine);
    };
    return { ...base, workflowInterceptorModules, ignoreModules, webpackConfigHook };
  }

  /**
   * Flush the LangSmith client on worker shutdown so traces that were emitted
   * just before exit are delivered. Wraps the worker run loop and flushes in a
   * `finally`, swallowing flush errors (shutdown must not fail on telemetry).
   */
  override async runWorker(worker: Worker, next: (worker: Worker) => Promise<void>): Promise<void> {
    try {
      await next(worker);
    } finally {
      await this.flush();
    }
  }

  /** Best-effort flush of any batched traces. */
  private async flush(): Promise<void> {
    const client = this.client as unknown as {
      awaitPendingTraceBatches?: () => Promise<void>;
      flush?: () => Promise<void>;
    };
    try {
      if (typeof client.awaitPendingTraceBatches === 'function') {
        await client.awaitPendingTraceBatches();
      } else if (typeof client.flush === 'function') {
        await client.flush();
      }
    } catch {
      /* swallow: telemetry flush must never fail worker shutdown */
    }
  }
}

/**
 * Redirect `node:async_hooks` to the workflow interceptor module so LangSmith's
 * `import { AsyncLocalStorage } from "node:async_hooks"` resolves to our
 * isolate-safe shim.
 *
 * `resolve.alias` does **not** work for this: webpack routes `node:`-scheme
 * requests through a dedicated scheme handler that runs before alias
 * resolution, so an aliased scheme request still raises `UnhandledSchemeError`.
 * `NormalModuleReplacementPlugin` instead rewrites the request in
 * `beforeResolve` — before scheme detection — turning it into an ordinary path
 * request that resolves normally.
 *
 * This rewrite is one half of a two-part fix; the other half is whitelisting
 * `async_hooks` in `ignoreModules` (see {@link LangSmithPlugin.configureBundler}).
 * The rewrite makes webpack *resolve* the request to our shim, but the SDK's
 * separate `captureProblematicModules` guard inspects the original dependency
 * request and would still abort the build on the disallowed `async_hooks`
 * builtin; `ignoreModules` dismisses that guard. Both are required.
 *
 * The rewrite target is the package specifier
 * `@temporalio/langsmith/workflow-interceptors` — **not** a path relative to
 * this file. The plugin runs from `lib/` (compiled) in production but from
 * `src/` under the test runner, where a relative `./workflow-interceptors.js`
 * would not exist and the rewrite would be silently dropped (the very bug that
 * left workflow-body `traceable` untested in an earlier revision). The package
 * specifier resolves identically from any issuer to the same compiled module
 * the `workflowModules` entry uses, so webpack keeps a single deduped instance
 * in the isolate — one shared context manager, no split state.
 */
function aliasAsyncHooks(config: WebpackConfiguration): WebpackConfiguration {
  const plugins = [...(config.plugins ?? [])];
  try {
    const webpack = require('webpack') as {
      NormalModuleReplacementPlugin: new (
        re: RegExp,
        cb: (resource: { request: string }) => void,
      ) => unknown;
    };
    plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:async_hooks$/, (resource) => {
        resource.request = WORKFLOW_INTERCEPTOR_MODULE;
      }) as (typeof plugins)[number],
    );
  } catch {
    /* webpack unavailable: leave plugins untouched (build will surface it) */
  }
  return { ...config, plugins };
}

/**
 * Append a `DefinePlugin`-equivalent to a webpack config without a static
 * `webpack` import (webpack is provided transitively by the worker). Falls back
 * to a no-op if `DefinePlugin` cannot be resolved, so bundling never breaks.
 */
function injectDefinePlugin(
  config: WebpackConfiguration,
  definitions: Record<string, string>,
): WebpackConfiguration {
  const plugins = [...(config.plugins ?? [])];
  try {
    const webpack = require('webpack') as { DefinePlugin: new (d: Record<string, string>) => unknown };
    plugins.push(new webpack.DefinePlugin(definitions) as (typeof plugins)[number]);
  } catch {
    /* webpack unavailable: leave plugins untouched, workflow uses defaults */
  }
  return { ...config, plugins };
}
