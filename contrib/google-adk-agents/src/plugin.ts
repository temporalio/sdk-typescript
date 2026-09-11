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

const ADK_PACKAGE = '@google/adk';

/**
 * Resolves the `@google/adk` entry the Workflow bundle uses: ADK's **web**
 * build (`dist/web/index_web.js`, the `common.ts` surface). ADK 2.0 publishes
 * the same sources three ways, and which one webpack picks for the bare
 * `@google/adk` specifier depends on the *consumer's* environment: the Worker
 * bundler sets no webpack `target`, so webpack defaults to `browserslist` when
 * the worker's cwd has a browserslist config and to `web` otherwise, and only
 * the latter activates the `browser` export condition. Left to that default, a
 * `"browserslist": ["node 20"]` in an app would flip the bundle to the node ESM
 * barrel, whose closure reaches ADK's optional peer dependencies (`express`,
 * `@a2a-js/sdk`, the MikroORM drivers, …) — uninstalled, hence build errors.
 *
 * The web surface is what a Workflow needs and nothing more: the runner, the
 * agent loop, the workflow (graph) runtime, HITL, plugins, compactors. It omits
 * the node-only services (a2a, database sessions, GCS artifacts, telemetry
 * setup, `LocalEnvironment`, the agent registry) and MCP — MCP traffic is
 * routed through Activities on the worker, where the full barrel is used. The
 * agent-loop sources are identical across builds. The `./dist/web/*` subpath
 * is part of ADK's `exports` map, so ordinary Node resolution finds it.
 */
function adkWebEntry(): string {
  return require.resolve(`${ADK_PACKAGE}/dist/web/index_web.js`);
}

/**
 * Whether a module request was issued from inside `@google/adk`'s own files,
 * so a shim can be scoped to ADK without changing what any other package in
 * the bundle sees. Matches both path separators.
 */
const ADK_ISSUER_PATTERN = /[\\/]@google[\\/]adk[\\/]/;

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
 * ESM source for the `os` builtin shim. ADK 1.x's `code_executors/
 * unsafe_local_code_executor.js` evaluated `os.platform()` at **module load**;
 * that file is not on ADK 2.0's web surface (the build the Workflow bundle now
 * pins), but several web-surface modules still import `node:os` for use inside
 * function bodies, and an inert surface keeps any future load-time reach from
 * failing the bundle. The bundler aliases the disallowed `os` builtin to an
 * empty module, so `os.platform` would be `undefined`; this shim returns
 * deterministic, side-effect-free constants instead — no real OS
 * introspection, nothing that could differ between the original execution and
 * a replay.
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
 *
 * Retained defensively: the DB session subtree is not on ADK 2.0's web surface
 * (the build the Workflow bundle pins), so this shim is only reached if a
 * consumer's own webpack hook re-aliases `@google/adk` to the node barrel.
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
 * ESM source replacing `@google/adk`'s `dist/web/models/apigee_llm.js`. ADK
 * 2.0.0's web build is compiled per file for old browser targets, and esbuild
 * lowers `ApigeeLlm`'s async-generator methods into nested `function*` bodies
 * that still say `super.generateContentAsync(...)` — `'super' keyword outside
 * a method`, a syntax error for webpack (and V8), so the whole bundle fails to
 * build. The class is unusable in a Workflow anyway (it proxies Gemini over the
 * network), so this inert stand-in keeps the module graph loading: same
 * `supportedModels` pattern (the registry registers it at load), same `BaseLlm`
 * brand symbol, and methods that fail with a message naming the actual fix. The upstream web build is
 * repaired in ADK 2.1 (it is bundled there).
 */
const APIGEE_LLM_SHIM_SOURCE =
  "var BASE_MODEL_SYMBOL=Symbol.for('google.adk.baseModel');" +
  'var MESSAGE="@google/adk\'s ApigeeLlm cannot run inside a Temporal Workflow: it performs network I/O. "+' +
  '"Wrap the model: new TemporalModel(\'apigee/…\').";' +
  'function ApigeeLlm(params){this.model=params&&params.model;this[BASE_MODEL_SYMBOL]=true;}' +
  'ApigeeLlm.supportedModels=[/apigee\\/.*/];' +
  'ApigeeLlm.prototype.maybeAppendUserContent=function(){};' +
  'ApigeeLlm.prototype.generateContentAsync=function(){throw new Error(MESSAGE);};' +
  'ApigeeLlm.prototype.connect=function(){return Promise.reject(new Error(MESSAGE));};' +
  'export {ApigeeLlm};\n';

/** Matches ADK's own relative requests for the module {@link APIGEE_LLM_SHIM_SOURCE} replaces. */
const APIGEE_LLM_REQUEST = /(?:^|[\\/])apigee_llm\.js$/;

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

/** The subset of webpack's `ResolveData` the `beforeResolve` tap reads. */
interface ResolveDataLike {
  request?: string;
  /** Directory of the importing module (webpack's resolve `context`). */
  context?: string;
  /** The importing module's own resource path, when webpack knows it. */
  contextInfo?: { issuer?: string };
}

/** Minimal shape of the webpack compiler/factory hooks we tap. */
interface NormalModuleFactoryLike {
  hooks: { beforeResolve: { tap(name: string, fn: (data: ResolveDataLike) => void): void } };
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
 * Third-party packages `@google/adk` imports for node-only work, stubbed
 * (`alias → false`, i.e. resolved to an empty module) in the Workflow bundle.
 * None of these run inside a Workflow — model and MCP I/O execute worker-side
 * in Activities — and every one is dereferenced by ADK only inside function
 * bodies that never run there, so aliasing to an empty module is load-safe and
 * severs the whole transitive node-only graph (`node:zlib`, `node:http2`, web
 * globals like `Event`/`Buffer` the sandbox lacks). The cut is at the
 * **third-party-package** boundary rather than ADK's own modules.
 *
 * With the bundle pinned to ADK 2.0's web surface ({@link adkWebEntry}), most
 * of these are no longer reached at all — the web surface omits the a2a, DB
 * session, GCS artifact, telemetry-setup and MCP subtrees that imported them.
 * The still-reached ones are `google-auth-library`, `@google-cloud/vertexai`
 * and `adm-zip`. The rest are retained as a safety net for a consumer whose
 * own webpack hook re-aliases `@google/adk` to the node barrel.
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
  // ADK 2.0's `skills/loader.js` (on the web surface) imports the zip reader
  // for `loadSkillFromZipBuffer`, dereferencing it only inside that function;
  // the package itself reaches `fs`/`zlib`/`Buffer` at load.
  'adm-zip',
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

/** Whether `request` names the `crypto` builtin in either form. */
function isCryptoRequest(request: string): boolean {
  return request === 'crypto' || request === `${NODE_SCHEME}crypto`;
}

/** Whether the module issuing a request lives inside `@google/adk`. */
function issuedByAdk(data: ResolveDataLike): boolean {
  const issuer = data.contextInfo?.issuer ?? data.context ?? '';
  return ADK_ISSUER_PATTERN.test(issuer);
}

/**
 * The webpack plugin that makes the `@google/adk` barrel load inside the
 * Workflow sandbox. It does four things:
 *
 *  1. **Deterministic `crypto` for ADK**: in `beforeResolve`, a `crypto` /
 *     `node:crypto` request issued from inside `@google/adk` is redirected to
 *     the plugin's {@link ./crypto-shim | crypto shim}, whose `randomUUID` /
 *     `getRandomValues` draw from a named workflow random stream. ADK's id
 *     generator (`utils/env_aware_utils.js`) falls through to that import when
 *     no `crypto` global exists, and the sandbox has none; without the shim the
 *     first `createEvent()` in a Workflow throws. The redirect is scoped to ADK
 *     issuers so no other package in the bundle sees a `crypto` it did not have
 *     before. The shim is a real module (not a `data:` URI) because it imports
 *     `@temporalio/workflow`.
 *  2. **Shim redirects** ({@link REQUEST_SHIM_SOURCES}): redirect the
 *     load-dereferenced requests to their inline `data:` URI shims.
 *  3. **`node:` scheme strip**: every other `node:<name>` → bare `<name>`. The
 *     Worker bundler aliases each disallowed builtin to `false` by its **bare**
 *     name; a `node:`-prefixed request never reaches `resolve.alias` — webpack's
 *     scheme handler intercepts it first and throws `UnhandledSchemeError` (a
 *     hard *build* failure). Stripping the scheme lets the bundler's bare-name
 *     policy take over.
 *  4. **`process` provide**: a `ProvidePlugin` injects the deterministic
 *     `process` shim ({@link PROCESS_SHIM_SOURCE}) wherever `process` is a free
 *     variable.
 */
function googleAdkSandboxCompatPlugin(): unknown {
  // Built worker-side only (this factory is called from `configureBundler`), so
  // `Buffer` is the real Node global here, not the sandbox stub.
  const shimUris = REQUEST_SHIM_SOURCES.map(([request, source]) => [request, toDataUri(source)] as const);
  const shimByRequest = new Map<string, string>(shimUris);
  const processShimUri = toDataUri(PROCESS_SHIM_SOURCE);
  const apigeeShimUri = toDataUri(APIGEE_LLM_SHIM_SOURCE);
  const cryptoShimPath = require.resolve('./crypto-shim');
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
          if (issuedByAdk(data)) {
            if (isCryptoRequest(request)) {
              data.request = cryptoShimPath;
              return;
            }
            if (APIGEE_LLM_REQUEST.test(request)) {
              data.request = apigeeShimUri;
              return;
            }
          }
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
 * Adds the sandbox-compat webpack plugin and two single-instance aliases to a
 * bundler `Configuration`, composing after any user-supplied hook so their
 * customizations are preserved.
 *
 * The aliases are webpack's standard pins: **exact-match** (`$`)
 * `resolve.alias` entries — the same declarative surface the Worker bundler
 * itself uses — so only the bare specifiers are pinned and subpath imports
 * resolve normally:
 *
 *  - `@opentelemetry/api` → the copy `@google/adk` resolves
 *    ({@link adkOtelApiEntry}); two api copies in one bundle silently drop
 *    every ADK span. `@opentelemetry/api-logs` is untouched.
 *  - `@google/adk` → ADK's web build ({@link adkWebEntry}), so the sandbox
 *    surface does not depend on the consumer's webpack target.
 *
 * Precedence is identical in both `resolve.alias` forms: alias entries
 * resolve first-match-first, the pins are placed first, so they win the bare
 * specifier over any user entry (exact- or prefix-form), while a user
 * prefix-form entry still applies to subpath imports.
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
    const pins: ReadonlyArray<readonly [string, string]> = [
      [OTEL_API_PACKAGE, adkOtelApiEntry()],
      [ADK_PACKAGE, adkWebEntry()],
    ];
    if (Array.isArray(alias)) {
      alias.unshift(...pins.map(([name, target]) => ({ name, onlyModule: true, alias: target })));
    } else {
      // Object-form aliases also match in key insertion order, so the pin keys
      // go first; the re-assignment restores a pin's target if the user
      // supplied the same exact-match key (a spread overwrites the value in
      // place, not the key's position).
      const pinned = Object.fromEntries(pins.map(([name, target]) => [`${name}$`, target]));
      const merged = { ...pinned, ...alias };
      Object.assign(merged, pinned);
      cfg.resolve = { ...cfg.resolve, alias: merged };
    }
    return cfg;
  };
}

/**
 * Worker-side configuration for {@link GoogleAdkPlugin}.
 *
 * API keys are NOT configured here — the model Activities read them from the
 * worker environment (e.g. `GOOGLE_GENAI_API_KEY` / `GEMINI_API_KEY`) or via a
 * custom `modelProvider`. The plugin never puts them in workflow or activity inputs.
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
   * The recipe has four parts, all required:
   *
   *  1. **`webpackConfigHook`** adds {@link googleAdkSandboxCompatPlugin} (the
   *     `node:` strip, the inline shim redirects, the ADK-scoped `crypto` and
   *     `apigee_llm.js` redirects, and the `process` provide) and two
   *     exact-match `resolve.alias` pins (see {@link addSandboxCompat}):
   *     `@opentelemetry/api` to the single copy ADK resolves, and `@google/adk`
   *     to ADK's web build ({@link adkWebEntry}) so the sandbox surface does not
   *     depend on the consumer's webpack target.
   *  2. **`ignoreModules`** stubs (`alias → false`) two groups: ADK's node-only
   *     third-party packages ({@link ADK_NODE_ONLY_SERVICE_PACKAGES}) and every
   *     disallowed Node builtin ({@link disallowedBuiltins}). The builtins are
   *     already aliased to `false` by the bundler — listing them additionally
   *     tells its determinism guard "expected, don't fail" for the few ADK
   *     *core* reaches on paths that never run in a Workflow.
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
   *  4. **`workflowInterceptorModules`** also gets the `absorbed-failure` module
   *     appended last — the module that re-raises a model failure ADK absorbed
   *     (`markModelFailureHandled` opts one back out). Interceptor modules compose
   *     first-is-outermost, so last means innermost, and the re-raise rejects
   *     *through* the outer interceptors rather than past them: an observability
   *     interceptor must not close its span OK on a Workflow about to fail. Being
   *     last is order-dependent, not structural — so list `GoogleAdkPlugin` last in
   *     `plugins`.
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
      workflowInterceptorModules: [
        require.resolve('./load-polyfills'),
        ...(base.workflowInterceptorModules ?? []),
        require.resolve('./absorbed-failure'),
      ],
      webpackConfigHook: addSandboxCompat(base.webpackConfigHook),
    };
  }
}
