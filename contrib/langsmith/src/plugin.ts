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

// Bare identifier (not dotted) so DefinePlugin substitutes textually.
const CONFIG_GLOBAL = '__TEMPORAL_LANGSMITH_CONFIG__';

// Bare builtin name added to `ignoreModules`; see {@link bundleRewritesPlugin}.
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
  // Absolute path so the workflow bundler resolves it under strict pnpm.
  private readonly workflowInterceptorModule = require.resolve('./workflow-interceptors');

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
    if (!workflowModules.includes(this.workflowInterceptorModule)) {
      workflowModules.push(this.workflowInterceptorModule);
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
    if (!workflowInterceptorModules.includes(this.workflowInterceptorModule)) {
      workflowInterceptorModules.push(this.workflowInterceptorModule);
    }
    // Dismiss the SDK bundler's disallowed-builtin guard for `async_hooks` (see bundleRewritesPlugin).
    const ignoreModules = [...(base.ignoreModules ?? [])];
    if (!ignoreModules.includes(ASYNC_HOOKS_MODULE)) {
      ignoreModules.push(ASYNC_HOOKS_MODULE);
    }
    const prevHook = base.webpackConfigHook;
    const webpackConfigHook = (config: WebpackConfiguration): WebpackConfiguration => {
      const merged = prevHook ? prevHook(config) : config;
      // Double-encode so the injected token is a string literal in the bundle.
      const definitions = { [CONFIG_GLOBAL]: JSON.stringify(JSON.stringify(this.workflowConfig)) };
      const plugins = [...(merged.plugins ?? [])];
      plugins.push(bundleRewritesPlugin(this.workflowInterceptorModule, definitions) as (typeof plugins)[number]);
      return { ...merged, plugins };
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
 * The slice of webpack's runtime API these rewrites use, read off the running
 * compiler (see {@link bundleRewritesPlugin}).
 */
interface WebpackApi {
  NormalModuleReplacementPlugin: new (
    resourceRegExp: RegExp,
    newResource: (resource: {
      request: string;
      context?: string;
      createData?: { resource?: string; userRequest?: string; request?: string };
    }) => void
  ) => WebpackPlugin;
  DefinePlugin: new (definitions: Record<string, string>) => WebpackPlugin;
}

interface WebpackPlugin {
  apply(compiler: WebpackCompiler): void;
}

interface WebpackCompiler {
  /** webpack 5 exposes its own runtime API on the compiler. */
  webpack: WebpackApi;
}

/**
 * A webpack plugin that installs the three Workflow-bundle rewrites LangSmith needs:
 *
 *  - redirect `node:async_hooks` to the isolate-safe workflow-interceptor shim.
 *    webpack routes `node:` requests through a scheme handler before alias
 *    resolution, so `resolve.alias` can't do this; `NormalModuleReplacementPlugin`
 *    rewrites the request in `beforeResolve`. Paired with the `ignoreModules`
 *    whitelist (see {@link LangSmithPlugin.configureBundler}). The rewrite target
 *    is the resolved absolute module path so webpack dedupes to one isolate
 *    instance regardless of issuer.
 *  - redirect langsmith's node-only `utils/{fs,worker_threads}.cjs` to their
 *    `.browser.cjs` siblings so node builtins stay out of the isolate. Scoped to
 *    langsmith so a user's own `fs.cjs` is never rewritten.
 *  - a `DefinePlugin` carrying the plugin config as a bundle-time literal.
 *
 * webpack is taken from `compiler.webpack` rather than imported: it backs the
 * SDK's Workflow bundler but is a dependency of `@temporalio/worker`, not of this
 * plugin, so a bare `require('webpack')` is unresolvable under non-hoisting
 * installers (e.g. pnpm with `hoist=false`). Using the compiler's own webpack
 * also guarantees the exact instance running the bundle — never a second copy.
 */
function bundleRewritesPlugin(workflowInterceptorModule: string, definitions: Record<string, string>): WebpackPlugin {
  const swap = (s: string): string => s.replace(/\.cjs$/, '.browser.cjs');
  return {
    apply(compiler) {
      const { NormalModuleReplacementPlugin, DefinePlugin } = compiler.webpack;

      new NormalModuleReplacementPlugin(/^node:async_hooks$/, (resource) => {
        resource.request = workflowInterceptorModule;
      }).apply(compiler);

      new NormalModuleReplacementPlugin(/[/\\]utils[/\\](?:fs|worker_threads)\.cjs$/, (resource) => {
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
      }).apply(compiler);

      new DefinePlugin(definitions).apply(compiler);
    },
  };
}
