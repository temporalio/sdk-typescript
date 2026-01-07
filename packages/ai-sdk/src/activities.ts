import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  EmbeddingModelV3Result,
  SharedV3ProviderOptions,
  SharedV3Headers,
  ProviderV3,
} from '@ai-sdk/provider';
import type { FlexibleSchema, ToolExecutionOptions } from 'ai';
import { ApplicationFailure } from '@temporalio/common';
import type { McpClientFactories, McpClientFactory } from './mcp';

/**
 * Arguments for invoking a language model activity.
 */
export interface InvokeModelArgs {
  modelId: string;
  options: LanguageModelV3CallOptions;
}

/**
 * Result from a language model invocation.
 * This is an alias to the AI SDK's LanguageModelV3GenerateResult for type safety.
 */
export type InvokeModelResult = LanguageModelV3GenerateResult;

/**
 * Arguments for invoking an embedding model activity.
 * Note: AbortSignal is not included as it cannot be serialized across activity boundaries.
 * Temporal's workflow cancellation provides equivalent functionality.
 */
export interface InvokeEmbeddingModelArgs {
  modelId: string;
  values: string[];
  providerOptions?: SharedV3ProviderOptions;
  headers?: SharedV3Headers;
}

/**
 * Result from an embedding model invocation.
 * This is an alias to the AI SDK's EmbeddingModelV3Result for type safety.
 */
export type InvokeEmbeddingModelResult = EmbeddingModelV3Result;

export interface ListToolResult {
  description?: string;
  inputSchema: FlexibleSchema<unknown>;
}

export interface ListToolArgs {
  clientArgs?: unknown;
}

export interface CallToolArgs {
  clientArgs?: unknown;
  name: string;
  input: unknown;
  options: ToolExecutionOptions;
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
export function createActivities(provider: ProviderV3, mcpClientFactories?: McpClientFactories): object {
  let activities = {
    async invokeModel(args: InvokeModelArgs): Promise<InvokeModelResult> {
      const model = provider.languageModel(args.modelId);
      return await model.doGenerate(args.options);
    },
    async invokeEmbeddingModel(args: InvokeEmbeddingModelArgs): Promise<InvokeEmbeddingModelResult> {
      const model = provider.embeddingModel(args.modelId);
      return await model.doEmbed({
        values: args.values,
        providerOptions: args.providerOptions,
        headers: args.headers,
      });
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
    try {
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
    } finally {
      await mcpClient.close();
    }
  }
  async function callToolActivity(args: CallToolArgs): Promise<unknown> {
    const mcpClient = await mcpClientFactory(args.clientArgs);
    try {
      const tools = await mcpClient.tools();
      const tool = tools[args.name];
      if (tool === undefined) {
        throw ApplicationFailure.retryable(`Tool ${args.name} not found.`);
      }
      return tool.execute(args.input, args.options);
    } finally {
      await mcpClient.close();
    }
  }
  return {
    [name + '-listTools']: listToolsActivity,
    [name + '-callTool']: callToolActivity,
  };
}
