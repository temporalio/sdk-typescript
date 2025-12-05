import type { ProviderV2 } from '@ai-sdk/provider';
import { SimplePlugin } from '@temporalio/plugin';
import { createActivities } from './activities';
import type { McpClientFactory } from './mcp';

/**
 * Options for the AI SDK plugin
 *
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export interface AiSdkPluginOptions {
  modelProvider: ProviderV2;
  mcpClientFactories?: [string, McpClientFactory][];
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
