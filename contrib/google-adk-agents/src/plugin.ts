/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 */

import { builtinModules, createRequire } from 'node:module';

import type { BaseLlm } from '@google/adk';
import { SimplePlugin } from '@temporalio/plugin';
import type { BundleOptions } from '@temporalio/worker';

import { createModelActivities, createMCPActivities } from './activities';
import { type MCPToolsetFactory } from './mcp';

/** The webpack `Configuration` object the bundler hands to `webpackConfigHook`. */
type WebpackConfig = Parameters<NonNullable<BundleOptions['webpackConfigHook']>>[0];

const NODE_SCHEME = 'node:';

const OTEL_API_PACKAGE = '@opentelemetry/api';

/**
 * Resolves the `@opentelemetry/api` copy that `@google/adk` itself resolves.
 * ADK pins an exact api version while other packages in the Workflow bundle
 * (notably `@temporalio/interceptors-opentelemetry`) may resolve a different
 * one, so without intervention the bundle can contain two api copies. ADK's
 * `telemetry/tracing.js` caches `trace.getTracer(...)` at module load; if that
 * binds a different api copy than the one the OTel interceptor registers its
 * tracer provider on, every ADK span is silently lost (the workflow still
 * succeeds and interceptor spans still export). Aliasing the bare
 * `@opentelemetry/api` specifier to ADK's copy ({@link addSandboxCompat})
 * keeps the tracer and the provider on the same registration regardless of
 * module evaluation order. The returned path is not hardcoded: it is whatever
 * file the package's own `exports` map designates as its entry, obtained
 * through ordinary Node resolution from ADK's entry point.
 */
function adkOtelApiEntry(): string {
  return createRequire(require.resolve('@google/adk')).resolve(OTEL_API_PACKAGE);
}

/**
 * ESM source for the `module` builtin shim. Every `@google/adk` compiled ESM
 * file carries an esbuild interop banner that *calls* `createRequire` at module
 * load. Aliasing `module` to `false` would make `createRequire` `undefined`, so
 * the banner's top-level call throws at Workflow load. This shim supplies a
 * `createRequire` returning a `require` that throws only if actually invoked,
 * so the banner runs harmlessly and no real `require()` resolution reaches a
 * Workflow. `builtinModules` is exported as an empty array purely to satisfy
 * the named import; it is only read on the worker (real `node:module`), never
 * inside a Workflow.
 */
const MODULE_SHIM_SOURCE =
  "export function createRequire(){return function(){throw new Error('require() is not available inside a Temporal Workflow sandbox');};}\n" +
  'export const builtinModules=[];\n' +
  'export default {createRequire,builtinModules};\n';

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
 * ESM source for the `net` builtin shim. `@google/adk` >= 1.5.0 ships
 * `tools/load_web_page.js` on the barrel path, which parses its blocked-CIDR
 * tables at **module load**, calling `isIP` from `node:net` in the process.
 * With `net` aliased to an empty module (like the other disallowed builtins),
 * `isIP` is `undefined` and that top-level call throws at Workflow load. The
 * shim reimplements the classifiers `isIP`/`isIPv4`/`isIPv6` with Node's own
 * address grammar (the regexes in Node's `lib/internal/net.js`): pure string
 * parsing, deterministic, frozen in the bundle (so classification cannot
 * drift between original execution and replay on a different worker), and no
 * socket surface.
 */
const NET_SHIM_SOURCE =
  "var v4Seg='(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';" +
  "var v4Str='(?:'+v4Seg+'\\\\.){3}'+v4Seg;" +
  "var IPv4Reg=new RegExp('^'+v4Str+'$');" +
  "var v6Seg='(?:[0-9a-fA-F]{1,4})';" +
  "var IPv6Reg=new RegExp('^(?:'+" +
  "'(?:'+v6Seg+':){7}(?:'+v6Seg+'|:)|'+" +
  "'(?:'+v6Seg+':){6}(?:'+v4Str+'|:'+v6Seg+'|:)|'+" +
  "'(?:'+v6Seg+':){5}(?::'+v4Str+'|(?::'+v6Seg+'){1,2}|:)|'+" +
  "'(?:'+v6Seg+':){4}(?:(?::'+v6Seg+'){0,1}:'+v4Str+'|(?::'+v6Seg+'){1,3}|:)|'+" +
  "'(?:'+v6Seg+':){3}(?:(?::'+v6Seg+'){0,2}:'+v4Str+'|(?::'+v6Seg+'){1,4}|:)|'+" +
  "'(?:'+v6Seg+':){2}(?:(?::'+v6Seg+'){0,3}:'+v4Str+'|(?::'+v6Seg+'){1,5}|:)|'+" +
  "'(?:'+v6Seg+':){1}(?:(?::'+v6Seg+'){0,4}:'+v4Str+'|(?::'+v6Seg+'){1,6}|:)|'+" +
  "'(?::(?:(?::'+v6Seg+'){0,5}:'+v4Str+'|(?::'+v6Seg+'){1,7}|:))'+" +
  "')(?:%[0-9a-zA-Z-.:]{1,})?$');" +
  'function isIPv4(s){return IPv4Reg.test(s);}' +
  'function isIPv6(s){return IPv6Reg.test(s);}' +
  'function isIP(s){if(isIPv4(s))return 4;if(isIPv6(s))return 6;return 0;}' +
  'export {isIP,isIPv4,isIPv6};' +
  'export default {isIP:isIP,isIPv4:isIPv4,isIPv6:isIPv6};\n';

/**
 * ESM source for the `async_hooks` builtin shim. ADK's `utils/client_labels.js`
 * executes `new AsyncLocalStorage()` at **module load** on the workflow-reached
 * path (`models/base_llm.js` imports it), and later uses only `run(store, fn)` /
 * `getStore()`. The Workflow sandbox injects a real, workflow-scoped
 * `AsyncLocalStorage` onto its `globalThis` (the SDK's own `CancellationScope`
 * is built on it), so re-exporting that global — the same contract as the
 * langsmith contrib's `async-hooks-shim` — gives ADK full async-context
 * tracking with sandbox-managed lifetime.
 */
const ASYNC_HOOKS_SHIM_SOURCE =
  'export const AsyncLocalStorage=globalThis.AsyncLocalStorage;export default {AsyncLocalStorage};\n';

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
  ['net', NET_SHIM_SOURCE],
  ['node:net', NET_SHIM_SOURCE],
  ['async_hooks', ASYNC_HOOKS_SHIM_SOURCE],
  ['node:async_hooks', ASYNC_HOOKS_SHIM_SOURCE],
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
 * forms). Computed lazily inside {@link GoogleAdkPlugin.configureBundler} — in
 * the Workflow sandbox bundle `node:module` resolves to the inline shim, whose
 * `builtinModules` is an inert empty array rather than the real list.
 * `configureBundler` only ever runs on the worker, where `node:module` is real.
 */
function disallowedBuiltins(): readonly string[] {
  return builtinModules.filter((m) => !POLYFILLED_BUILTINS.has(m));
}

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
 * them at module load on the in-Workflow path. (`@opentelemetry/api` is
 * additionally pinned to a single bundle copy — see {@link adkOtelApiEntry}.)
 */
const ADK_NODE_ONLY_SERVICE_PACKAGES: readonly string[] = [
  'google-auth-library',
  'gaxios',
  'node-fetch',
  // NOTE: `@mikro-orm/core` is NOT here — it gets an inert *shim* (see
  // REQUEST_SHIM_SOURCES), not an empty-module alias.
  '@mikro-orm/knex',
  '@mikro-orm/reflection',
  '@mikro-orm/postgresql',
  // `pg` (PostgreSQL driver, reached via `@mikro-orm/postgresql`) optionally
  // requires the native `pg-native` addon at module load, which webpack cannot
  // resolve. Severing `pg` from the Workflow bundle silences that warning; it
  // only runs in the DB-session subtree, never inside a Workflow.
  'pg',
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
  //
  // `@opentelemetry/sdk-trace-base` and `@opentelemetry/resources` must NOT be
  // listed: they are pure-JS, and `@temporalio/interceptors-opentelemetry(-v2)`
  // constructs a `BasicTracerProvider` from them *inside the Workflow sandbox* —
  // the SDK's only replay-safe workflow span path (spans leave the isolate via a
  // replay-gated sink). Stubbing them is bundle-wide and would break composing
  // this plugin with `OpenTelemetryPlugin` for every workflow on the worker.
  '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/resource-detector-gcp',
  '@opentelemetry/sdk-logs',
  '@opentelemetry/sdk-metrics',
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
 * Adds the sandbox-compat webpack plugin and the single-copy
 * `@opentelemetry/api` alias to a bundler `Configuration`, composing after any
 * user-supplied hook so their customizations are preserved.
 *
 * The alias is webpack's standard single-instance pin: an **exact-match**
 * (`$`) `resolve.alias` entry — the same declarative surface the Worker
 * bundler itself uses — so only the bare `@opentelemetry/api` specifier is
 * pinned to the copy `@google/adk` resolves ({@link adkOtelApiEntry});
 * `@opentelemetry/api-logs` and subpath imports resolve normally. It is
 * applied after the user hook because two api copies in one bundle silently
 * drop every ADK span (see {@link adkOtelApiEntry}).
 *
 * Precedence is identical in both `resolve.alias` forms: alias entries
 * resolve first-match-first, the pin is placed first, so it wins the bare
 * specifier over any user entry (exact- or prefix-form), while a user
 * prefix-form `@opentelemetry/api` entry still applies to subpath imports.
 */
function addSandboxCompat(
  existing: BundleOptions['webpackConfigHook']
): NonNullable<BundleOptions['webpackConfigHook']> {
  return (config: WebpackConfig): WebpackConfig => {
    const cfg = existing ? existing(config) : config;
    const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : [];
    type PluginElement = NonNullable<WebpackConfig['plugins']>[number];
    cfg.plugins = [...plugins, googleAdkSandboxCompatPlugin() as PluginElement];
    const alias = cfg.resolve?.alias;
    const pinTarget = adkOtelApiEntry();
    if (Array.isArray(alias)) {
      alias.unshift({ name: OTEL_API_PACKAGE, onlyModule: true, alias: pinTarget });
    } else {
      // Object-form aliases also match in key insertion order, so the pin key
      // goes first; the re-assignment restores the pin's target if the user
      // supplied the same exact-match key (a spread overwrites the value in
      // place, not the key's position).
      const merged = { [`${OTEL_API_PACKAGE}$`]: pinTarget, ...alias };
      merged[`${OTEL_API_PACKAGE}$`] = pinTarget;
      cfg.resolve = { ...cfg.resolve, alias: merged };
    }
    return cfg;
  };
}

/**
 * Worker-side configuration for {@link GoogleAdkPlugin}.
 *
 * API keys are NOT configured here — the model Activities read them from the
 * worker environment (e.g. `GOOGLE_API_KEY` / `GEMINI_API_KEY`) or via a custom
 * `modelProvider`. The plugin never puts them in workflow or activity inputs.
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
   * `new TemporalMCPToolset({ name })`.
   */
  mcpToolsets?: Record<string, MCPToolsetFactory>;
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
        ...createMCPActivities(options.mcpToolsets),
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
   * The recipe has three parts, all required:
   *
   *  1. **`webpackConfigHook`** adds {@link googleAdkSandboxCompatPlugin} (the
   *     `node:` strip, shim redirects, and `process` provide) and the
   *     exact-match `resolve.alias` pin of `@opentelemetry/api` to a single
   *     bundle copy (see {@link addSandboxCompat}).
   *  2. **`ignoreModules`** stubs (`alias → false`) two groups: ADK's heavy
   *     node-only *service* packages ({@link ADK_NODE_ONLY_SERVICE_PACKAGES})
   *     and every disallowed Node
   *     builtin ({@link disallowedBuiltins}). The builtins are already aliased to
   *     `false` by the bundler — listing them additionally tells its determinism
   *     guard "expected, don't fail" for the few ADK *core* reaches on paths that
   *     never run in a Workflow.
   *  3. **`workflowInterceptorModules`** gets the `load-polyfills` module
   *     prepended. Interceptor modules are evaluated per workflow — with the
   *     activator installed — *before* the user's workflow module (the
   *     `initRuntime` contract in `@temporalio/workflow`'s worker-interface:
   *     it sets the activator, then imports interceptor modules in list order,
   *     then imports workflows), so the web globals
   *     `@google/adk`/`@google/genai` and ADK's OpenTelemetry chain
   *     dereference at module load (`ReadableStream`, `performance`, …) exist
   *     no matter what order the user's own imports evaluate in. The module
   *     exports an `interceptors` factory that registers nothing, per the
   *     documented interceptor-module contract. (A webpack entry preload would
   *     not work: entry code evaluates at bundle load, before any activator,
   *     where the polyfill's `inWorkflowContext()` gate is false — and in the
   *     reusable-V8-context mode the no-op evaluation would be cached and
   *     never re-run.)
   *     Known gap: custom payload/failure converter modules
   *     (`payloadConverterPath` / `failureConverterPath`) evaluate *before*
   *     interceptor modules, so a converter module that itself imports
   *     `@google/adk`/`@google/genai` must import
   *     `@temporalio/google-adk-agents/workflow` (or `./load-polyfills`) first
   *     to install the polyfills.
   *
   * Tradeoff: putting **all** disallowed builtins in `ignoreModules` suppresses
   * the bundler's friendly "you imported a Node builtin in your Workflow"
   * build-time error (for the user's own Workflow code too). Runtime determinism
   * is still enforced by the sandbox — a real `fs` call from Workflow code throws
   * there — so the safety property is preserved.
   */
  override configureBundler(options: BundleOptions): BundleOptions {
    const base = super.configureBundler(options);
    const ignoreModules = [...(base.ignoreModules ?? []), ...ADK_NODE_ONLY_SERVICE_PACKAGES, ...disallowedBuiltins()];
    return {
      ...base,
      ignoreModules,
      workflowInterceptorModules: [require.resolve('./load-polyfills'), ...(base.workflowInterceptorModules ?? [])],
      webpackConfigHook: addSandboxCompat(base.webpackConfigHook),
    };
  }
}
