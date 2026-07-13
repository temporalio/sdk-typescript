// Workflow-safe exports — importable from Workflow code running in the V8 sandbox.
//
// Workflow code should import from '@temporalio/ai-sdk/workflow' rather than the package
// root: the root barrel also re-exports the worker-side activities and plugin, whose
// transitive imports (`@temporalio/activity`, `@temporalio/client`, `crypto`, ...) are
// disallowed by the workflow bundler.
// The Web-API polyfills the AI SDK needs inside the sandbox (`TransformStream`, `Headers`, ...)
// are installed by AiSdkPlugin.configureBundler, which prepends a polyfill-installer module to
// the workflow bundle's webpack entry. Build the bundle through the plugin (pass it to
// `Worker.create` with `workflowsPath`, or to `bundleWorkflowCode` via `plugins`) — the globals
// then exist before any workflow code, including `ai`, is evaluated, regardless of import order.
export { TemporalProvider, TemporalLanguageModel, TemporalEmbeddingModel, temporalProvider } from './provider';
export type { TemporalProviderOptions } from './provider';
export { TemporalMCPClient } from './mcp';
export type { TemporalMCPClientOptions, McpClientFactory, McpClientFactories } from './mcp';
