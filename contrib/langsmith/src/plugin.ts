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

import type * as nexus from 'nexus-rpc';
import { SimplePlugin } from '@temporalio/plugin';
import type { ClientOptions } from '@temporalio/client';
import type { BundleOptions, ReplayWorkerOptions, Worker, WorkerInterceptors, WorkerOptions } from '@temporalio/worker';
import { createActivityInboundInterceptor, createNexusInboundInterceptor } from './activity-interceptor';
import { createClientInterceptor } from './client-interceptor';
import { createLangSmithSinks } from './sinks';
import type { EmitterConfig } from './sinks';
import type { WorkflowLangSmithConfig } from './workflow-interceptors';

// Derived: @temporalio/worker doesn't export WebpackConfiguration from its root.
type WebpackConfiguration = Parameters<NonNullable<BundleOptions['webpackConfigHook']>>[0];

/**
 * The module specifier for the workflow-side interceptors.
 */
const WORKFLOW_INTERCEPTOR_MODULE = '@temporalio/langsmith/workflow-interceptors';

// Bare identifier (not dotted) so DefinePlugin substitutes textually.
const CONFIG_GLOBAL = '__TEMPORAL_LANGSMITH_CONFIG__';

// Bare builtin name added to `ignoreModules`; see {@link aliasAsyncHooks}.
const ASYNC_HOOKS_MODULE = 'async_hooks';

/**
 * Options for {@link LangSmithPlugin}.
 *
 * Secrets (the LangSmith API key) are never accepted here as plaintext and
 * never cross a Temporal boundary — supply a pre-constructed {@link Client}
 * (which reads `LANGSMITH_API_KEY` from the worker/client process env) or let
 * the plugin construct a default client from the environment.
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
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
   * boundaries so they nest correctly.
   */
  addTemporalRuns?: boolean;
  /** Tags attached to every run the plugin emits. */
  tags?: string[];
  /** Metadata merged into every run the plugin emits (credential keys scrubbed). */
  metadata?: Record<string, unknown>;
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
 *
 * @experimental Plugins is an experimental feature; APIs may change without notice.
 */
export class LangSmithPlugin extends SimplePlugin {
  private readonly client: Client;
  private readonly emitter: EmitterConfig;
  private readonly workflowConfig: WorkflowLangSmithConfig;

  constructor(options: LangSmithPluginOptions = {}) {
    // super() reads options.name immediately
    super({ name: 'langchain.LangSmithPlugin' });
    this.client = options.client ?? new Client();
    const addTemporalRuns = options.addTemporalRuns ?? false;
    this.emitter = {
      client: this.client,
      addTemporalRuns,
      projectName: options.projectName,
      tags: options.tags,
      metadata: options.metadata,
    };
    this.workflowConfig = {
      addTemporalRuns,
      projectName: options.projectName,
      tags: options.tags,
      metadata: options.metadata,
    };
  }

  override configureClient(options: ClientOptions): ClientOptions {
    const base = super.configureClient(options);
    const existing = base.interceptors ?? {};
    const workflow = Array.isArray(existing.workflow) ? [...existing.workflow] : [];
    workflow.push(createClientInterceptor(this.emitter));
    return { ...base, interceptors: { ...existing, workflow } };
  }

  override configureWorker(options: WorkerOptions): WorkerOptions {
    return this.withLangSmithWorker(super.configureWorker(options));
  }

  override configureReplayWorker(options: ReplayWorkerOptions): ReplayWorkerOptions {
    return this.withLangSmithWorker(super.configureReplayWorker(options));
  }

  private withLangSmithWorker<T extends WorkerOptions | ReplayWorkerOptions>(options: T): T {
    const interceptors: WorkerInterceptors = options.interceptors ?? {};

    const activityInbound = [...(interceptors.activityInbound ?? [])];
    activityInbound.push(createActivityInboundInterceptor(this.emitter));

    const workflowModules = [...(interceptors.workflowModules ?? [])];
    if (!workflowModules.includes(WORKFLOW_INTERCEPTOR_MODULE)) {
      workflowModules.push(WORKFLOW_INTERCEPTOR_MODULE);
    }

    const nexusInbound = createNexusInboundInterceptor(this.emitter);
    const nexusInterceptors = [...(interceptors.nexus ?? [])];
    nexusInterceptors.push((_ctx: nexus.OperationContext) => ({ inbound: nexusInbound }));

    // The user's own Worker sinks take precedence on any key collision.
    const sinks = { ...createLangSmithSinks(this.client), ...(options.sinks ?? {}) };

    return {
      ...options,
      interceptors: { ...interceptors, activityInbound, workflowModules, nexus: nexusInterceptors },
      sinks,
    } as T;
  }

  override configureBundler(options: BundleOptions): BundleOptions {
    const base = super.configureBundler(options);
    const workflowInterceptorModules = [...(base.workflowInterceptorModules ?? [])];
    if (!workflowInterceptorModules.includes(WORKFLOW_INTERCEPTOR_MODULE)) {
      workflowInterceptorModules.push(WORKFLOW_INTERCEPTOR_MODULE);
    }
    // Dismiss the SDK bundler's disallowed-builtin guard for `async_hooks` (see aliasAsyncHooks).
    const ignoreModules = [...(base.ignoreModules ?? [])];
    if (!ignoreModules.includes(ASYNC_HOOKS_MODULE)) {
      ignoreModules.push(ASYNC_HOOKS_MODULE);
    }
    const prevHook = base.webpackConfigHook;
    const webpackConfigHook = (config: WebpackConfiguration): WebpackConfiguration => {
      const merged = prevHook ? prevHook(config) : config;
      // Double-encode so the injected token is a string literal in the bundle.
      const definitions = { [CONFIG_GLOBAL]: JSON.stringify(JSON.stringify(this.workflowConfig)) };
      const withDefine = injectDefinePlugin(merged, definitions);
      return aliasLangSmithNodeUtils(aliasAsyncHooks(withDefine));
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

  private async flush(): Promise<void> {
    try {
      await this.client.awaitPendingTraceBatches();
    } catch {
      /* swallow: telemetry flush must never fail worker shutdown */
    }
  }
}

/**
 * Redirect `node:async_hooks` to the workflow interceptor module's isolate-safe
 * shim. webpack routes `node:` requests through a scheme handler before alias
 * resolution, so `resolve.alias` cannot do this; `NormalModuleReplacementPlugin`
 * rewrites the request in `beforeResolve` instead. Must be paired with the
 * `ignoreModules` whitelist (see {@link LangSmithPlugin.configureBundler}). The
 * rewrite target is the package specifier so webpack dedupes to one isolate
 * instance regardless of issuer.
 */
function aliasAsyncHooks(config: WebpackConfiguration): WebpackConfiguration {
  const plugins = [...(config.plugins ?? [])];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webpack = require('webpack') as {
      NormalModuleReplacementPlugin: new (re: RegExp, cb: (resource: { request: string }) => void) => unknown;
    };
    plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:async_hooks$/, (resource) => {
        resource.request = WORKFLOW_INTERCEPTOR_MODULE;
      }) as (typeof plugins)[number]
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'MODULE_NOT_FOUND') throw err;
    /* webpack genuinely absent (MODULE_NOT_FOUND): leave plugins untouched; any other failure rethrows. */
  }
  return { ...config, plugins };
}

/**
 * Redirect langsmith's node-only CJS utilities to its `.browser.cjs` siblings so
 * the workflow bundle keeps node builtins out of the isolate. Scoped to langsmith
 * so a user's own `fs.cjs` is never rewritten.
 */
function aliasLangSmithNodeUtils(config: WebpackConfiguration): WebpackConfiguration {
  const plugins = [...(config.plugins ?? [])];
  const swap = (s: string): string => s.replace(/\.cjs$/, '.browser.cjs');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webpack = require('webpack') as {
      NormalModuleReplacementPlugin: new (
        re: RegExp,
        cb: (resource: {
          request: string;
          context?: string;
          createData?: { resource?: string; userRequest?: string; request?: string };
        }) => void
      ) => unknown;
    };
    plugins.push(
      new webpack.NormalModuleReplacementPlugin(/[/\\]utils[/\\](?:fs|worker_threads)\.cjs$/, (resource) => {
        // Resolved sibling-relative requires (`./fs.cjs`) carry the absolute
        // path on `createData.resource`; raw `beforeResolve` requests carry it
        // on `request`.
        const createData = resource.createData;
        if (createData && typeof createData.resource === 'string') {
          if (!createData.resource.includes('langsmith') || createData.resource.includes('.browser.cjs')) {
            return;
          }
          createData.resource = swap(createData.resource);
          if (typeof createData.userRequest === 'string') {
            createData.userRequest = swap(createData.userRequest);
          }
          if (typeof createData.request === 'string') {
            createData.request = swap(createData.request);
          }
          return;
        }
        if (!resource.context || !resource.context.includes('langsmith') || resource.request.includes('.browser.cjs')) {
          return;
        }
        resource.request = swap(resource.request);
      }) as (typeof plugins)[number]
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'MODULE_NOT_FOUND') throw err;
    /* webpack genuinely absent (MODULE_NOT_FOUND): leave plugins untouched; any other failure rethrows. */
  }
  return { ...config, plugins };
}

/**
 * Append a `DefinePlugin`-equivalent to a webpack config without a static
 * `webpack` import (webpack is provided transitively by the worker).
 */
function injectDefinePlugin(config: WebpackConfiguration, definitions: Record<string, string>): WebpackConfiguration {
  const plugins = [...(config.plugins ?? [])];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webpack = require('webpack') as { DefinePlugin: new (d: Record<string, string>) => unknown };
    plugins.push(new webpack.DefinePlugin(definitions) as (typeof plugins)[number]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'MODULE_NOT_FOUND') throw err;
    /* webpack genuinely absent (MODULE_NOT_FOUND): leave plugins untouched, workflow uses defaults; any other failure rethrows. */
  }
  return { ...config, plugins };
}
