import type {
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2ResponseMetadata,
  LanguageModelV2Usage,
  ProviderV2,
  SharedV2Headers,
  SharedV2ProviderMetadata,
} from '@ai-sdk/provider';
import type { ToolCallOptions } from 'ai';
import type { McpClientFactories, McpClientFactory } from './mcp';

export interface InvokeModelArgs {
  modelId: string;
  options: LanguageModelV2CallOptions;
}

export interface InvokeModelResult {
  content: Array<LanguageModelV2Content>;
  finishReason: LanguageModelV2FinishReason;
  usage: LanguageModelV2Usage;
  providerMetadata?: SharedV2ProviderMetadata;
  request?: { body?: unknown };
  response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
  warnings: Array<LanguageModelV2CallWarning>;
}

export interface ListToolResult {
  description?: string;
  inputSchema: any;
}

export interface ListToolArgs {
  clientArgs?: any;
}

export interface CallToolArgs {
  clientArgs?: any;
  name: string;
  args: any;
  options: ToolCallOptions;
}

/**
 * Creates Temporal activities for AI model invocation using the provided AI SDK provider.
 * These activities allow workflows to call AI models while maintaining Temporal's
 * execution guarantees and replay safety.
 *
 * @param provider The AI SDK provider to use for model invocations
 * @param mcpClientFactories A mapping of server names to functions to create mcp clients
 * @returns An object containing the activity functions
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export function createActivities(provider: ProviderV2, mcpClientFactories?: McpClientFactories): object {
  let activities = {
    async invokeModel(args: InvokeModelArgs): Promise<InvokeModelResult> {
      const model = provider.languageModel(args.modelId);
      return await model.doGenerate(args.options);
    },
  };
  if (mcpClientFactories !== undefined) {
    Object.entries(mcpClientFactories).forEach(([name, func]) => {
      activities = {
        ...activities,
        ...activitiesForName(name, func),
      };
    });
  }
  return activities;
}

function activitiesForName(name: string, mcpClientFactory: McpClientFactory): object {
  async function listToolsActivity(args: ListToolArgs): Promise<Record<string, ListToolResult>> {
    const mcpClient = await mcpClientFactory(args.clientArgs);
    const tools = await mcpClient.tools();

    return Object.fromEntries(
      Object.entries(tools).map(([k, v]) => [
        k,
        {
          description: v.description,
          inputSchema: v.inputSchema,
        },
      ])
    );
  }
  async function callToolActivity(args: CallToolArgs): Promise<any> {
    const mcpClient = await mcpClientFactory(args.clientArgs);
    const tools = await mcpClient.tools();
    const tool = tools[args.name];
    if (tool === undefined) {
      throw new Error(`Tool ${args.name} not found.`);
    }
    return tool.execute(args.args, args.options);
  }
  return {
    [name + '-listTools']: listToolsActivity,
    [name + '-callTool']: callToolActivity,
  };
}
