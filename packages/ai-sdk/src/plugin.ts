import type { ProviderV3 } from '@ai-sdk/provider';
import { SimplePlugin } from '@temporalio/plugin';
import { createActivities } from './activities';
import type { McpClientFactories } from './mcp';

/**
 * Options for the AI SDK plugin
 *
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export interface AiSdkPluginOptions {
  modelProvider: ProviderV3;

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
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export class AiSdkPlugin extends SimplePlugin {
  constructor(options: AiSdkPluginOptions) {
    super({
      name: 'AiSDKPlugin',
      activities: createActivities(options.modelProvider, options.mcpClientFactories),
    });
  }
}
