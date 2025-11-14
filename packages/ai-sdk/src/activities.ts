import {
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
import type { experimental_MCPClient as MCPClient } from '@ai-sdk/mcp';
import { ToolCallOptions } from 'ai';

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
 * @param mcpClientFactory
 * @returns An object containing the activity functions
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export const createActivities = (provider: ProviderV2, mcpClientFactory?: (_: any) => Promise<MCPClient>): object => {
  const activities = {
    async invokeModel(
      modelId: string,
      options: LanguageModelV2CallOptions
    ): Promise<{
      content: Array<LanguageModelV2Content>;
      finishReason: LanguageModelV2FinishReason;
      usage: LanguageModelV2Usage;
      providerMetadata?: SharedV2ProviderMetadata;
      request?: { body?: unknown };
      response?: LanguageModelV2ResponseMetadata & { headers?: SharedV2Headers; body?: unknown };
      warnings: Array<LanguageModelV2CallWarning>;
    }> {
      const model = provider.languageModel(modelId);
      return await model.doGenerate(options);
    },
  };
  if (mcpClientFactory === undefined) {
    return activities;
  }
  return {
    ...activities,
    async listTools(args: ListToolArgs): Promise<Record<string, ListToolResult>> {
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
    },
    async callTool(args: CallToolArgs): Promise<any> {
      const mcpClient = await mcpClientFactory(args.clientArgs);
      const tools = await mcpClient.tools();
      return tools[args.name].execute(args.args, args.options);
    },
  };
};
