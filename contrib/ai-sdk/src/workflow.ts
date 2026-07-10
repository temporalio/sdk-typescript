// Workflow-safe exports — importable from Workflow code running in the V8 sandbox.
//
// Workflow code should import from '@temporalio/ai-sdk/workflow' rather than the package
// root: the root barrel also re-exports the worker-side activities and plugin, whose
// transitive imports (`@temporalio/activity`, `@temporalio/client`, `crypto`, ...) are
// disallowed by the workflow bundler.
import { installPolyfills } from './load-polyfills';

// Install the Web-API polyfills the AI SDK needs inside the sandbox. This runs when the module
// loads so the globals exist before the `ai` package is evaluated — import this entry point
// before `ai` in workflow code.
installPolyfills();

export { installPolyfills } from './load-polyfills';
export { TemporalProvider, TemporalLanguageModel, TemporalEmbeddingModel, temporalProvider } from './provider';
export type { TemporalProviderOptions } from './provider';
export { TemporalMCPClient } from './mcp';
export type { TemporalMCPClientOptions, McpClientFactory, McpClientFactories } from './mcp';
