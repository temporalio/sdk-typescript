import type { ProviderV4 } from '@ai-sdk/provider';
import { SimplePlugin } from '@temporalio/plugin';
import type { BundleOptions } from '@temporalio/worker';
import { createActivities } from './activities';
import type { McpClientFactories } from './mcp';

/**
 * Options for the AI SDK plugin
 *
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export interface AiSdkPluginOptions {
  modelProvider: ProviderV4;

  /**
   * This object contains a mapping of server names to functions which create MCP clients.
   * Any TemporalMCPClient used in a workflow should have its associated servername listed in this object.
   */
  mcpClientFactories?: McpClientFactories;
}

/**
 * A Temporal plugin that integrates AI SDK providers for use in workflows.
 * This plugin creates activities that allow workflows to invoke AI models.
 *
 * Workflow code should import from `@temporalio/ai-sdk/workflow` (not the package root) so the
 * workflow bundle doesn't pull in the worker-side activities and their disallowed imports.
 *
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export class AiSdkPlugin extends SimplePlugin {
  constructor(options: AiSdkPluginOptions) {
    super({
      name: 'AiSDKPlugin',
      activities: createActivities(options.modelProvider, options.mcpClientFactories),
    });
  }

  override configureBundler(options: BundleOptions): BundleOptions {
    // Prepend a polyfill-installer module to the webpack `entry` array so it
    // evaluates before any other module in the Workflow bundle. Webpack 5
    // emits multi-entry scripts that execute in array order at script-load,
    // so this guarantees the Web-API globals (`TransformStream`, `Headers`,
    // ...) exist before `ai` is evaluated (it defines `class ... extends
    // TransformStream` at module scope), making the relative import order of
    // `@temporalio/ai-sdk/workflow` and `ai` in workflow code irrelevant.
    const polyfillPath = require.resolve('./preload-polyfills');
    const baseOptions = super.configureBundler(options);
    const existingHook = baseOptions.webpackConfigHook;
    return {
      ...baseOptions,
      webpackConfigHook: (config) => {
        const cfg = existingHook ? existingHook(config) : config;
        const existingEntry = cfg.entry;
        const entries = Array.isArray(existingEntry)
          ? existingEntry
          : existingEntry !== undefined
            ? [existingEntry as string]
            : [];
        return { ...cfg, entry: [polyfillPath, ...entries] };
      },
    };
  }
}
