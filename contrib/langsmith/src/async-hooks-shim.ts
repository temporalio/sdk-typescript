/**
 * Bundle-time stand-in for `node:async_hooks` inside the workflow isolate, where
 * that builtin is unavailable. The plugin's bundler aliases `node:async_hooks`
 * to this module (see {@link bundleRewritesPlugin} in `plugin.ts`) so LangSmith's
 * `import { AsyncLocalStorage } from "node:async_hooks"` — including its
 * `new AsyncLocalStorage()` and static `AsyncLocalStorage.snapshot()` — resolves
 * to the real, async-context-tracking `AsyncLocalStorage` the SDK worker injects
 * onto the workflow-sandbox global.
 *
 * @module
 * @internal
 */

declare const globalThis: { AsyncLocalStorage: typeof import('node:async_hooks').AsyncLocalStorage };

export const AsyncLocalStorage = globalThis.AsyncLocalStorage;
