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
 * ESM source for the `module` builtin shim. Every `@google/adk` compiled ESM
 * file carries an esbuild interop banner that *calls* `createRequire` at module
 * load. Aliasing `module` to `false` would make `createRequire` `undefined`, so
 * the banner's top-level call throws at Workflow load. This shim supplies a
 * `createRequire` returning a `require` that throws only if actually invoked,
 * so the banner runs harmlessly and no real `require()` resolution reaches a
 * Workflow.
 */
const MODULE_SHIM_SOURCE =
  "export function createRequire(){return function(){throw new Error('require() is not available inside a Temporal Workflow sandbox');};}\n" +
  'export default {createRequire};\n';

/**
 * ESM source for the `winston` shim. ADK's `utils/logger.js` eagerly constructs
 * a `winston.createLogger(...)` at module load, dragging in `@colors/colors`
 * whose color-support probe touches `process`/`os` at load and throws in the
 * sandbox. Logging is irrelevant inside a Workflow (Temporal supplies the
 * Workflow logger), so a no-op `winston` surface severs the whole logging
 * subtree.
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
 * wherever `process` is a free variable. ADK core reads `process.env` /
 * `process.platform` at module load on workflow-reached paths, and the Workflow
 * sandbox has no `process` global. This shim provides a deterministic,
 * side-effect-free `process` (empty `env`, no-TTY streams, microtask `nextTick`)
 * — nothing that performs real I/O or introduces nondeterminism.
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
 * unsafe_local_code_executor.js` evaluates `os.platform()` at **module load**.
 * The bundler aliases the disallowed `os` builtin to an empty module, so
 * `os.platform` is `undefined` and that top-level call throws at Workflow load.
 * This shim returns deterministic, side-effect-free constants so the load is
 * inert — no real OS introspection, nothing that could differ between the
 * original execution and a replay.
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
 * ESM source for the `@mikro-orm/core` shim. ADK's DB session subtree
 * subclasses (`class … extends JsonType`) and decorates
 * (`Entity`/`PrimaryKey`/`Property`) with this ORM's exports at **module load**,
 * so it can't be aliased to an empty module like the other node-only service
 * packages. This shim supplies an inert load surface: `JsonType`/`MikroORM` are
 * inert classes, the decorators are no-op factories, `LockMode` is an empty enum.
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
 * Requests redirected (in `beforeResolve`) to an inline `data:` URI shim. These
 * are the packages/builtins ADK *dereferences at module load* (subclasses,
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
 * transitively (the public barrel value-exports {@link GoogleAdkPlugin}, which
 * imports the Activity implementations in `./activities.ts`); none of that code
 * path runs inside a Workflow. `ignoreModules` (the Worker bundler's own
 * remediation for this case) aliases them to `false` in the Workflow bundle;
 * they are defined but never dereferenced at Workflow runtime.
 */
const WORKER_ONLY_TEMPORAL_PACKAGES: readonly string[] = ['@temporalio/activity', '@temporalio/client'];

/**
 * `@google/adk`'s node-only **service** subtrees (telemetry, Cloud
 * SQL/Mongo session stores, stdio-MCP transport, GCS/Vertex artifact stores,
 * a2a HTTP) eagerly import these heavy third-party packages, which in turn
 * import `node:`-prefixed builtins (`node:zlib`, `node:http2`, …) and reference
 * web globals (`Event`, `Buffer`) the sandbox lacks. None of these run inside a
 * Workflow — model and MCP I/O execute worker-side in Activities — so they are
 * stubbed (`alias → false`, i.e. resolved to an empty module) in the Workflow
 * bundle. The cut is at the **third-party-package** boundary (rather than ADK's
 * own service modules) because every one of these is dereferenced by ADK only
 * inside function bodies that never run in a Workflow, so aliasing them to an
 * empty module is load-safe and severs the whole transitive node-only graph.
 *
 * The two packages ADK dereferences *at module load* are handled as shims
 * instead, not here: `@mikro-orm/core` and `winston` — see
 * {@link REQUEST_SHIM_SOURCES}. `@opentelemetry/api` and `@opentelemetry/api-logs`
 * are deliberately *absent* (kept real): they are pure-JS API packages with no
 * node builtins, and `telemetry/tracing.js` calls `trace.getTracer(...)` from
 * them at module load on the in-Workflow path.
 */
const ADK_NODE_ONLY_SERVICE_PACKAGES: readonly string[] = [
  'google-auth-library',
  'gaxios',
  'node-fetch',
  // NOTE: `@mikro-orm/core` is NOT here — it gets an inert *shim* (see
  // REQUEST_SHIM_SOURCES), not an empty-module alias.
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
  // setup functions that never run in a Workflow, so aliasing to an empty module
  // is load-safe. (`@opentelemetry/api` + `api-logs` are intentionally kept
  // real — see the doc comment above.)
  '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/resources',
  '@opentelemetry/resource-detector-gcp',
  '@opentelemetry/sdk-logs',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-trace-node',
  // The A2A (agent-to-agent) protocol subtree: ADK's `a2a/*` reach `@a2a-js/sdk`
  // and `express`, whose server/buffer code touches the web `Event` global /
  // `Buffer.from` at load (both absent in the sandbox). ADK dereferences them
  // only inside methods, so alias → false is load-safe and severs the subtree
  // (webpack prefix-matches `/server`, `/client`, `/server/express`).
  '@a2a-js/sdk',
  'express',
];

/**
 * The webpack plugin that makes the `@google/adk` barrel load inside the
 * Workflow sandbox. It does three things:
 *
 *  1. **Shim redirects** ({@link REQUEST_SHIM_SOURCES}): in `beforeResolve`,
 *     redirect the load-dereferenced requests to their inline `data:` URI shims.
 *  2. **`node:` scheme strip**: every other `node:<name>` → bare `<name>`. The
 *     Worker bundler aliases each disallowed builtin to `false` by its **bare**
 *     name; a `node:`-prefixed request never reaches `resolve.alias` — webpack's
 *     scheme handler intercepts it first and throws `UnhandledSchemeError` (a
 *     hard *build* failure). Stripping the scheme lets the bundler's bare-name
 *     policy take over.
 *  3. **`process` provide**: a `ProvidePlugin` injects the deterministic
 *     `process` shim ({@link PROCESS_SHIM_SOURCE}) wherever `process` is a free
 *     variable.
 */
function googleAdkSandboxCompatPlugin(): unknown {
  // Built worker-side only (this factory is called from `configureBundler`), so
  // `Buffer` is the real Node global here, not the sandbox stub.
  const shimUris = REQUEST_SHIM_SOURCES.map(([request, source]) => [request, toDataUri(source)] as const);
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
  existing: BundleOptions['webpackConfigHook']
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
   * `new TemporalMcpToolSet({ name })`.
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
   * The recipe has two parts, both required:
   *
   *  1. **`webpackConfigHook`** adds {@link googleAdkSandboxCompatPlugin} (the
   *     `node:` strip, shim redirects, and `process` provide).
   *  2. **`ignoreModules`** stubs (`alias → false`) three groups: ADK's heavy
   *     node-only *service* packages ({@link ADK_NODE_ONLY_SERVICE_PACKAGES});
   *     the worker-only `@temporalio/*` packages
   *     ({@link WORKER_ONLY_TEMPORAL_PACKAGES}); and every disallowed Node
   *     builtin ({@link disallowedBuiltins}). The builtins are already aliased to
   *     `false` by the bundler — listing them additionally tells its determinism
   *     guard "expected, don't fail" for the few ADK *core* reaches on paths that
   *     never run in a Workflow.
   *
   * Tradeoff: putting **all** disallowed builtins in `ignoreModules` suppresses
   * the bundler's friendly "you imported a Node builtin in your Workflow"
   * build-time error (for the user's own Workflow code too). Runtime determinism
   * is still enforced by the sandbox — a real `fs` call from Workflow code throws
   * there — so the safety property is preserved.
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
