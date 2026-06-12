/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * `GoogleAdkPlugin` — the Worker/Client plugin that makes `@google/adk`
 * durable under Temporal. Add it to `plugins: [...]` on your Client (it
 * auto-propagates to Workers) or directly on the Worker. It registers the
 * model Activities (`invokeModel`, `invokeModelStreaming`) and one
 * `<name>-listTools` / `<name>-callTool` pair per configured MCP toolset.
 */

import { builtinModules } from 'node:module';

import type { BaseLlm } from '@google/adk';
import { SimplePlugin } from '@temporalio/plugin';
import type { BundleOptions } from '@temporalio/worker';

import { createModelActivities, createMcpActivities } from './activities.js';
import { type McpToolsetFactory } from './mcp.js';

/** The webpack `Configuration` object the bundler hands to `webpackConfigHook`. */
type WebpackConfig = Parameters<NonNullable<BundleOptions['webpackConfigHook']>>[0];

const NODE_SCHEME = 'node:';

/**
 * ESM source for the `module` builtin shim.
 *
 * Every `@google/adk` compiled ESM file carries an esbuild interop banner —
 * `import {createRequire} from 'module'; const require = createRequire(import.meta.url);`
 * — that *calls* `createRequire` at module load. On every workflow-reached path
 * the resulting `require` is dead (only `sessions/db/operations` and
 * `tools/skill/run_skill_script_tool` ever invoke it, and neither runs inside a
 * Workflow). Aliasing `module` to `false` — the bundler's default for a
 * disallowed builtin — makes `createRequire` `undefined`, so the banner's
 * top-level call throws `createRequire is not a function` at Workflow load.
 *
 * This shim supplies a `createRequire` that returns a `require` which throws
 * *only if actually invoked*. The harmless banner runs; the determinism
 * guarantee (no real `require()` resolution inside a Workflow) is preserved.
 */
const MODULE_SHIM_SOURCE =
  "export function createRequire(){return function(){throw new Error('require() is not available inside a Temporal Workflow sandbox');};}\n" +
  'export default {createRequire};\n';

/**
 * ESM source for the `winston` shim. ADK's `utils/logger.js` eagerly constructs
 * a `winston.createLogger(...)` at module load (`let currentLogger = new
 * SimpleLogger()`), which drags `logform` → `@colors/colors` → `os` into the
 * Workflow bundle; `@colors`' color-support probe touches `process`/`os` at load
 * and throws in the sandbox. Logging is irrelevant inside a Workflow (Temporal
 * supplies the Workflow logger), so the whole logging subtree is severed here
 * with a no-op `winston` surface covering exactly what `logger.js` touches:
 * `createLogger`, the callable `format` plus its `combine`/`label`/`colorize`/
 * `timestamp`/`printf` statics, and `transports.Console`.
 */
const WINSTON_SHIM_SOURCE =
  'function noop(){}' +
  'function fmt(){return function(){return {};};}' +
  'fmt.combine=function(){return {};};fmt.label=function(){return {};};' +
  'fmt.colorize=function(){return {};};fmt.timestamp=function(){return {};};' +
  'fmt.printf=function(){return {};};fmt.json=function(){return {};};' +
  'fmt.simple=function(){return {};};fmt.errors=function(){return {};};' +
  'function createLogger(){return {log:noop,debug:noop,info:noop,warn:noop,error:noop,' +
  'add:noop,remove:noop,child:function(){return this;}};}' +
  'function Console(){}function File(){}' +
  'var transports={Console:Console,File:File};var format=fmt;' +
  'export {createLogger,format,transports};' +
  'export default {createLogger:createLogger,format:format,transports:transports};\n';

/**
 * ESM source for the `process` global shim, injected via webpack `ProvidePlugin`
 * wherever `process` is a free variable. Twelve ADK *core* files
 * (`runner.js`, `llm_agent.js`, `env_aware_utils.js`, `models/google_llm.js`, …)
 * read `process.env` / `process.platform` at module load on workflow-reached
 * paths; the Workflow sandbox has no `process` global, so those reads throw
 * `process is not defined`. This shim provides a deterministic, side-effect-free
 * `process`: a frozen-empty `env` (so reads are constant across original run and
 * replay), no-TTY streams, and microtask-based `nextTick` — nothing that
 * performs real I/O or introduces nondeterminism.
 */
const PROCESS_SHIM_SOURCE =
  'function noop(){}' +
  'var s={isTTY:false,write:function(){return true;},on:noop,once:noop,end:noop};' +
  'var proc={env:{},platform:"linux",arch:"x64",argv:[],argv0:"node",execPath:"",' +
  'version:"v0.0.0",versions:{node:"0.0.0"},pid:0,title:"workflow",browser:false,' +
  'cwd:function(){return "/";},chdir:noop,' +
  'nextTick:function(cb){var a=Array.prototype.slice.call(arguments,1);' +
  'Promise.resolve().then(function(){cb.apply(null,a);});},' +
  'stdout:s,stderr:s,stdin:s,on:noop,off:noop,once:noop,addListener:noop,' +
  'removeListener:noop,emit:function(){return false;},exit:noop,emitWarning:noop,' +
  'hrtime:Object.assign(function(){return [0,0];},{bigint:function(){return BigInt(0);}}),' +
  'memoryUsage:function(){return {rss:0,heapTotal:0,heapUsed:0,external:0};},' +
  'uptime:function(){return 0;}};' +
  'export default proc;\n';

/**
 * ESM source for the `os` builtin shim. ADK's `code_executors/
 * unsafe_local_code_executor.js` evaluates `const IS_WINDOWS = os.platform() ===
 * "win32";` at **module load** (the only module-scope Node-builtin dereference in
 * the entire `@google/adk` dist — verified by scanning every compiled file). The
 * bundler aliases the disallowed `os` builtin to an empty module, so `os.platform`
 * is `undefined` and that top-level call throws `os.platform is not a function` at
 * Workflow load. The local code executor never runs inside a Workflow (it spawns
 * child processes, which the sandbox forbids), so this shim only needs to make its
 * *load* inert: it returns deterministic, side-effect-free constants (`platform()
 * → "linux"`, `tmpdir() → "/tmp"`, …) — no real OS introspection, nothing that
 * could differ between the original execution and a replay.
 */
const OS_SHIM_SOURCE =
  'function constFn(v){return function(){return v;};}' +
  'var platform=constFn("linux");var arch=constFn("x64");var type=constFn("Linux");' +
  'var release=constFn("0.0.0");var version=constFn("");var machine=constFn("x86_64");' +
  'var tmpdir=constFn("/tmp");var homedir=constFn("/");var hostname=constFn("workflow");' +
  'var EOL="\\n";var devNull="/dev/null";var endianness=constFn("LE");' +
  'var cpus=constFn([]);var totalmem=constFn(0);var freemem=constFn(0);' +
  'var loadavg=constFn([0,0,0]);var uptime=constFn(0);var networkInterfaces=constFn({});' +
  'var userInfo=constFn({username:"",uid:-1,gid:-1,shell:null,homedir:"/"});' +
  'var constants={};' +
  'export {platform,arch,type,release,version,machine,tmpdir,homedir,hostname,EOL,' +
  'devNull,endianness,cpus,totalmem,freemem,loadavg,uptime,networkInterfaces,userInfo,constants};' +
  'export default {platform:platform,arch:arch,type:type,release:release,version:version,' +
  'machine:machine,tmpdir:tmpdir,homedir:homedir,hostname:hostname,EOL:EOL,devNull:devNull,' +
  'endianness:endianness,cpus:cpus,totalmem:totalmem,freemem:freemem,loadavg:loadavg,' +
  'uptime:uptime,networkInterfaces:networkInterfaces,userInfo:userInfo,constants:constants};\n';

/**
 * ESM source for the `@mikro-orm/core` shim. ADK's DB session subtree references
 * this ORM's exports at **module load**, so it can't be aliased to an empty
 * module like the other node-only service packages: `sessions/db/schema.js`
 * does `class CamelCaseToSnakeCaseJsonType extends JsonType {…}` (needs `JsonType`
 * to be a constructor) and applies `Entity`/`PrimaryKey`/`Property` decorators via
 * the esbuild `__decorateClass` helper at top level (needs each to be a
 * decorator-returning factory); `sessions/database_session_service.js` imports
 * `LockMode`/`MikroORM`. The `DatabaseSessionService` performs real database I/O
 * and therefore can never run inside a Workflow (sessions there are in-memory), so
 * this shim only has to make the subtree's *load* succeed: `JsonType`/`MikroORM`
 * are inert classes, the three decorators are no-op factories, `LockMode` is an
 * empty enum. Any actual use throws a clear sandbox error.
 */
const MIKRO_ORM_SHIM_SOURCE =
  'class JsonType {}' +
  'class MikroORM {static init(){throw new Error("@mikro-orm is not available inside a Temporal Workflow sandbox");}}' +
  'function decorator(){return function(){};}' +
  'function Entity(){return decorator();}' +
  'function PrimaryKey(){return decorator();}' +
  'function Property(){return decorator();}' +
  'var LockMode={};' +
  'export {JsonType,MikroORM,Entity,PrimaryKey,Property,LockMode};' +
  'export default {JsonType:JsonType,MikroORM:MikroORM,Entity:Entity,' +
  'PrimaryKey:PrimaryKey,Property:Property,LockMode:LockMode};\n';

/**
 * Requests redirected (in `beforeResolve`) to an inline `data:` URI shim instead
 * of being resolved normally / aliased to `false`. See each shim's doc above.
 *
 * These are the packages/builtins ADK *dereferences at module load* (subclasses,
 * decorates, or calls a member of) and so cannot be aliased to an empty module —
 * each shim supplies exactly the inert surface ADK touches at load. Everything
 * ADK only touches *inside function bodies* stays in the `alias → false` lists
 * ({@link ADK_NODE_ONLY_SERVICE_PACKAGES}, {@link disallowedBuiltins}) instead.
 */
const REQUEST_SHIM_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ['module', MODULE_SHIM_SOURCE],
  ['node:module', MODULE_SHIM_SOURCE],
  ['winston', WINSTON_SHIM_SOURCE],
  ['os', OS_SHIM_SOURCE],
  ['node:os', OS_SHIM_SOURCE],
  ['@mikro-orm/core', MIKRO_ORM_SHIM_SOURCE],
];

/** Encodes ESM shim source as a base64 `data:` URI webpack can bundle inline. */
function toDataUri(source: string): string {
  return 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
}

/** Minimal shape of the webpack compiler/factory hooks we tap. */
interface NormalModuleFactoryLike {
  hooks: { beforeResolve: { tap(name: string, fn: (data: { request?: string }) => void): void } };
}
interface ProvidePluginLike {
  apply(compiler: WebpackCompilerLike): void;
}
interface WebpackCompilerLike {
  hooks: {
    normalModuleFactory: { tap(name: string, fn: (nmf: NormalModuleFactoryLike) => void): void };
  };
  /** webpack 5 exposes its own exports here, so we never `import 'webpack'`. */
  webpack: {
    // A `[request, ...path]` value injects a *specific* export, e.g.
    // `[uri, 'default']` injects the module's default export rather than its
    // namespace object — required so the injected `process` is the shim object
    // itself, not `{ default: shim }`.
    ProvidePlugin: new (definitions: Record<string, string | string[]>) => ProvidePluginLike;
  };
}

/**
 * The polyfilled trio: the only Node builtins the Workflow sandbox provides
 * deterministic overrides for. Everything else in `builtinModules` is
 * "disallowed" — the Worker bundler aliases each disallowed builtin to `false`
 * and (separately) records any *reached* disallowed builtin so it can fail the
 * build with a friendly "you imported a Node builtin in a Workflow" message.
 *
 * This set must match the Worker bundler's own `disallowedBuiltinModules`
 * computation (`builtinModules.filter(m => !['assert','url','util'].includes(m))`)
 * so the two agree on which names are aliasable.
 */
const POLYFILLED_BUILTINS = new Set(['assert', 'url', 'util']);

/**
 * Every Node builtin the Workflow sandbox does NOT polyfill (bare + `node:`
 * forms). Computed lazily inside {@link GoogleAdkPlugin.configureBundler} — the
 * top-level `import { builtinModules } from 'node:module'` resolves to `false`
 * inside the Workflow sandbox bundle (every Node builtin is aliased away), so
 * touching `builtinModules` at module top level would throw at Workflow load.
 * `configureBundler` only ever runs on the worker, where `node:module` is real.
 */
function disallowedBuiltins(): readonly string[] {
  return builtinModules.filter((m) => !POLYFILLED_BUILTINS.has(m));
}

/**
 * `@temporalio/*` packages that are worker-only and must never execute in the
 * Workflow sandbox. They enter the Workflow bundle's import graph only
 * transitively: the public barrel value-exports {@link GoogleAdkPlugin}, which
 * imports the Activity implementations (`./activities.ts`), which import
 * `@temporalio/activity` (the Activity `Context`) and, via
 * `@temporalio/workflow-streams/client`, `@temporalio/client`. None of that
 * code path runs inside a Workflow — the Activities execute worker-side and the
 * plugin is only ever *constructed* on the worker. The Worker bundler's own
 * remediation for exactly this case is `ignoreModules` (its "disallowed
 * modules" build error names it), which aliases them to `false` in the Workflow
 * bundle; they are defined but never dereferenced at Workflow runtime.
 */
const WORKER_ONLY_TEMPORAL_PACKAGES: readonly string[] = [
  '@temporalio/activity',
  '@temporalio/client',
];

/**
 * `@google/adk`'s node-only **service** subtrees (telemetry, Cloud
 * SQL/Mongo session stores, stdio-MCP transport, GCS/Vertex artifact stores,
 * a2a HTTP) eagerly import these heavy third-party packages, which in turn
 * import `node:`-prefixed builtins (`node:zlib`, `node:http2`, …) and reference
 * web globals (`Event`, `Buffer`) the sandbox lacks. None of these run inside a
 * Workflow — model and MCP I/O execute worker-side in Activities — so they are
 * stubbed (`alias → false`, i.e. resolved to an empty module) in the Workflow
 * bundle.
 *
 * Why cut at the **third-party-package** boundary rather than stubbing ADK's own
 * service *modules* (`telemetry/google_cloud.js`, `sessions/database_session_service.js`,
 * …)? Two reasons. (1) Correctness margin: this exact set is ADK's node-only
 * runtime dependencies (verified against its `package.json`), and every one of
 * them is dereferenced by ADK *only inside function bodies* that never execute in
 * a Workflow (the agent loop calls neither the GCP exporters nor the DB session
 * store), so aliasing them to an empty module is load-safe and severs the whole
 * transitive node-only graph. (2) Version-robustness: these are
 * capability-defining packages (network/disk/child-process I/O) that a Workflow
 * must never invoke — a precise, self-documenting cut — whereas ADK's internal
 * file layout shifts more across releases than its dependency list does. The two
 * packages ADK dereferences *at module load* are handled as shims instead, not
 * here: `@mikro-orm/core` (subclassed/decorated in `sessions/db/schema.js`) and
 * `winston` (constructed in `utils/logger.js`) — see {@link REQUEST_SHIM_SOURCES}.
 * `@opentelemetry/api` and `@opentelemetry/api-logs` are deliberately *absent*
 * (kept real): they are pure-JS API packages with no node builtins, and
 * `telemetry/tracing.js` calls `trace.getTracer(...)` from them at module load on
 * the in-Workflow path.
 */
const ADK_NODE_ONLY_SERVICE_PACKAGES: readonly string[] = [
  'google-auth-library',
  'gaxios',
  'node-fetch',
  // NOTE: `@mikro-orm/core` is NOT here — ADK subclasses/decorates with its
  // exports at module load, so it gets an inert *shim* (see MIKRO_ORM_SHIM_SOURCE
  // / REQUEST_SHIM_SOURCES) rather than an empty-module alias.
  '@mikro-orm/knex',
  '@mikro-orm/reflection',
  '@google-cloud/storage',
  '@google-cloud/vertexai',
  '@google-cloud/opentelemetry-cloud-trace-exporter',
  '@google-cloud/opentelemetry-cloud-monitoring-exporter',
  '@modelcontextprotocol/sdk',
  'googleapis',
  // OpenTelemetry node-only SDK/exporter/detector packages. ADK's
  // `telemetry/{setup,google_cloud}.js` import these but use them only inside
  // setup functions (`maybeSetOtelProviders`, `getGcpExporters`, …) that never
  // run in a Workflow; the GCP resource detector in particular drags in
  // `gcp-metadata` → `google-logging-utils` (a `class extends`-at-load chain).
  // Aliasing to an empty module is load-safe. (`@opentelemetry/api` +
  // `api-logs` are intentionally kept real — see the doc comment above.)
  '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/resources',
  '@opentelemetry/resource-detector-gcp',
  '@opentelemetry/sdk-logs',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-trace-node',
  // The A2A (agent-to-agent) protocol subtree: ADK's `a2a/*` reach
  // `@a2a-js/sdk` (and, via `@a2a-js/sdk/server/express`, `express`). Its server
  // entry references the web `Event` global at load, which the sandbox lacks.
  // ADK's a2a files dereference these only inside methods, so aliasing the
  // package (webpack prefix-matches `/server`, `/client`, `/server/express`) to
  // `false` is load-safe and severs the whole a2a + express subtree.
  '@a2a-js/sdk',
  // `a2a/agent_to_a2a.js` *also* imports `express` directly; express →
  // `safe-buffer` touches `Buffer.from` at load (no `Buffer` in the sandbox).
  // Used only inside route-builder functions, so alias → false is load-safe.
  'express',
];

/**
 * The webpack plugin that makes the `@google/adk` barrel load inside the
 * Workflow sandbox. It does three things:
 *
 *  1. **Shim redirects** ({@link REQUEST_SHIM_SOURCES}): in `beforeResolve`,
 *     `module`/`node:module` → a `createRequire` shim ({@link MODULE_SHIM_SOURCE})
 *     and `winston` → a no-op logging shim ({@link WINSTON_SHIM_SOURCE}), each as
 *     an inline `data:` URI module. Aliasing these to `false` would throw at load
 *     because ADK *calls* into them eagerly (`createRequire(...)`,
 *     `new SimpleLogger()`).
 *  2. **`node:` scheme strip**: every other `node:<name>` → bare `<name>`. The
 *     Worker bundler aliases each disallowed builtin to `false` by its **bare**
 *     name (`fs`, `zlib`, …); a `node:`-prefixed request never reaches
 *     `resolve.alias` — webpack's scheme handler intercepts it first and, on a
 *     non-node target, throws `UnhandledSchemeError` (a hard *build* failure).
 *     Stripping the scheme converts `node:zlib` → `zlib`, after which the
 *     bundler's bare-name policy takes over (polyfill trio → sandbox overrides,
 *     the rest → `false`).
 *  3. **`process` provide**: a `ProvidePlugin` injects a deterministic `process`
 *     shim ({@link PROCESS_SHIM_SOURCE}) wherever `process` is a free variable —
 *     ADK core reads `process.env`/`process.platform` at load and the sandbox
 *     has no `process`.
 *
 * The redirects and strip are dependency-agnostic and version-robust — they
 * complete webpack's own builtin handling rather than enumerating which
 * transitive dep uses the `node:` form.
 */
function googleAdkSandboxCompatPlugin(): unknown {
  // Built worker-side only (this factory is called from `configureBundler`), so
  // `Buffer` is the real Node global here, not the sandbox stub.
  const shimUris = REQUEST_SHIM_SOURCES.map(
    ([request, source]) => [request, toDataUri(source)] as const,
  );
  const shimByRequest = new Map<string, string>(shimUris);
  const processShimUri = toDataUri(PROCESS_SHIM_SOURCE);
  return {
    name: 'google-adk-sandbox-compat',
    apply(compiler: WebpackCompilerLike): void {
      // `[uri, 'default']` injects the shim's *default export* (the `process`
      // object), not the module namespace `{ default: … }`; otherwise
      // `process.stderr`/`process.env` would be `undefined`.
      new compiler.webpack.ProvidePlugin({ process: [processShimUri, 'default'] }).apply(compiler);
      compiler.hooks.normalModuleFactory.tap('GoogleAdkSandboxCompat', (nmf) => {
        nmf.hooks.beforeResolve.tap('GoogleAdkSandboxCompat', (data) => {
          const request = data.request;
          if (!request) return;
          const shim = shimByRequest.get(request);
          if (shim !== undefined) {
            data.request = shim;
            return;
          }
          if (request.startsWith(NODE_SCHEME)) {
            data.request = request.slice(NODE_SCHEME.length);
          }
        });
      });
    },
  };
}

/**
 * Adds the sandbox-compat webpack plugin to a bundler `Configuration`, composing
 * after any user-supplied hook so their customizations are preserved.
 */
function addSandboxCompat(
  existing: BundleOptions['webpackConfigHook'],
): NonNullable<BundleOptions['webpackConfigHook']> {
  return (config: WebpackConfig): WebpackConfig => {
    const cfg = existing ? existing(config) : config;
    const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : [];
    type PluginElement = NonNullable<WebpackConfig['plugins']>[number];
    cfg.plugins = [...plugins, googleAdkSandboxCompatPlugin() as PluginElement];
    return cfg;
  };
}

/**
 * Worker-side configuration for {@link GoogleAdkPlugin}.
 *
 * API keys are NOT configured here — the model Activities read them from the
 * worker environment (e.g. `GOOGLE_API_KEY` / `GEMINI_API_KEY`) or via a
 * custom `modelProvider`. They never enter workflow or activity inputs.
 *
 * @experimental
 */
export interface GoogleAdkPluginOptions {
  /**
   * Reconstructs a `BaseLlm` from a model name inside the model Activities.
   * Defaults to the ADK `LLMRegistry`. Use this to inject API keys, point at a
   * proxy, or supply a test double.
   */
  modelProvider?: (model: string) => BaseLlm;
  /**
   * Named MCP toolset factories. Each key `name` becomes a
   * `<name>-listTools` / `<name>-callTool` Activity pair; the factory opens
   * the real MCP session on the worker. The matching workflow-side handle is
   * `new TemporalMcpToolset({ name })`.
   */
  mcpToolsets?: Record<string, McpToolsetFactory>;
}

/**
 * The Temporal plugin for the Google Agent Development Kit (`@google/adk`).
 *
 * The plugin's central mechanism is to run the **native** ADK `Runner` and
 * agent graph *inside* the Workflow sandbox (deterministic) while routing only
 * the non-deterministic I/O boundaries — model inference and MCP server calls —
 * out to Activities. Making that work requires the `@google/adk` barrel to
 * bundle into the Workflow sandbox; {@link GoogleAdkPlugin.configureBundler}
 * is what makes the bundle build (see the recipe documented there).
 *
 * @experimental
 */
export class GoogleAdkPlugin extends SimplePlugin {
  /**
   * @param options Worker-side model + MCP configuration.
   */
  constructor(options: GoogleAdkPluginOptions = {}) {
    super({
      name: 'google.AdkPlugin',
      // Object-keyed activities dedupe by name in the TS SDK's plugin merge
      // (`{...existing, ...param}`), so double-registration (e.g. the plugin
      // passed to both Client and Worker) is tolerated rather than a crash.
      activities: {
        ...createModelActivities(options),
        ...createMcpActivities(options.mcpToolsets),
      },
    });
  }

  /**
   * Makes the `@google/adk` agent loop bundle into the Workflow sandbox.
   *
   * `configureBundler` is the single canonical bundling hook — the Worker runs
   * it for both live execution and replay (`Worker.create` and
   * `Worker.runReplayHistory` both bundle through `getOrCreateBundle`), so the
   * recipe applies identically on both paths and there is no separate
   * `configureWorker`/`configureReplayWorker` bundler override.
   *
   * The recipe has two parts; both are required and were verified by booting a
   * real Worker against the `@google/adk` barrel through `Worker.create`:
   *
   *  1. **`webpackConfigHook`** adds {@link googleAdkSandboxCompatPlugin}, which
   *     (a) strips the `node:` scheme so disallowed builtins hit the bundler's
   *     bare-name alias policy instead of raising `UnhandledSchemeError` (a hard
   *     *build* failure) for ADK's transitive node-only imports
   *     (`node:zlib` via `node-fetch`→`gaxios`→`google-auth-library`, etc.);
   *     (b) redirects `module`/`winston` to inline `data:` URI shims that ADK
   *     calls into eagerly at load; and (c) provides a deterministic `process`
   *     global ADK core reads at load. Without it the bundle fails to build or
   *     throws at Workflow load.
   *  2. **`ignoreModules`** stubs (`alias → false`) three groups: ADK's heavy
   *     node-only *service* packages ({@link ADK_NODE_ONLY_SERVICE_PACKAGES}),
   *     which cuts the bulk of the node-only graph at the package boundary; the
   *     worker-only `@temporalio/*` packages the Activity implementations pull in
   *     ({@link WORKER_ONLY_TEMPORAL_PACKAGES}), which enter the bundle only
   *     because the public barrel value-exports this plugin; and every
   *     disallowed Node builtin ({@link disallowedBuiltins}). ADK *core*
   *     itself references a few builtins (`fs/promises`, `os`, `path`, `events`,
   *     `process`) on paths that never run in a Workflow; without listing them
   *     the bundler's determinism guard records the *reached* builtin and
   *     rejects the build. The builtins are already aliased to `false` by the
   *     bundler — adding them to `ignoreModules` additionally tells the guard
   *     "expected, don't fail."
   *
   * Deviation note (tradeoff): putting **all** disallowed builtins in
   * `ignoreModules` globally suppresses the bundler's friendly
   * "you imported a Node builtin in your Workflow" build-time error — for the
   * user's own Workflow code too, not just ADK's. This is an accepted tradeoff:
   * a static list of "exactly the builtins ADK core reaches" is neither
   * complete nor stable across `@google/adk` releases, and the Workflow sandbox
   * still enforces determinism at **runtime** (a real `fs` call from Workflow
   * code throws there). We trade a friendlier build-time message for a
   * version-robust bundle; the safety property (no nondeterministic I/O in the
   * Workflow) is preserved by the runtime sandbox.
   */
  override configureBundler(options: BundleOptions): BundleOptions {
    const base = super.configureBundler(options);
    const ignoreModules = [
      ...(base.ignoreModules ?? []),
      ...ADK_NODE_ONLY_SERVICE_PACKAGES,
      ...WORKER_ONLY_TEMPORAL_PACKAGES,
      ...disallowedBuiltins(),
    ];
    return {
      ...base,
      ignoreModules,
      webpackConfigHook: addSandboxCompat(base.webpackConfigHook),
    };
  }
}
