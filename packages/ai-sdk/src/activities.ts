import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
  EmbeddingModelV3Result,
  SharedV3ProviderOptions,
  SharedV3Headers,
  SharedV3Warning,
  ProviderV3,
} from '@ai-sdk/provider';
import { asSchema, type Schema, type ToolExecutionOptions } from 'ai';
import { ApplicationFailure } from '@temporalio/common';
import { Context } from '@temporalio/activity';
import { WorkflowStreamClient } from '@temporalio/contrib-workflow-stream';
import type { McpClientFactories, McpClientFactory } from './mcp';

const EVENTS_TOPIC = 'events';
const encoder = new TextEncoder();

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
  inputSchema: Schema<unknown>;
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
export function createActivities(
  provider: ProviderV3,
  mcpClientFactories?: McpClientFactories
): object {
  let activities = {
    async invokeModel(args: InvokeModelArgs): Promise<InvokeModelResult> {
      const model = provider.languageModel(args.modelId);
      return await model.doGenerate(args.options);
    },

    /**
     * Streaming-aware model activity.
     *
     * Calls `model.doStream()`, publishes each yielded AI SDK stream part
     * as JSON to the stream side channel, and returns the assembled
     * `LanguageModelV3GenerateResult`. Consumers receive native AI SDK
     * stream-part types (text-delta, reasoning-delta, tool-input-delta,
     * response-metadata, finish, ...); no normalization happens here.
     */
    async invokeModelStreaming(args: InvokeModelArgs): Promise<InvokeModelResult> {
      const stream = WorkflowStreamClient.fromActivity({ batchInterval: '100 milliseconds' });
      stream.start();
      const events = stream.topic(EVENTS_TOPIC);

      const model = provider.languageModel(args.modelId);
      const streamResult = await model.doStream(args.options);

      const content: LanguageModelV3Content[] = [];
      let finishReason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined };
      let usage: LanguageModelV3Usage = {
        inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      };
      const warnings: SharedV3Warning[] = [];
      let responseMetadata: Record<string, unknown> | undefined;

      let currentText = '';
      let currentReasoning = '';

      try {
        const reader = streamResult.stream.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value: part } = await reader.read();
          if (done) break;

          Context.current().heartbeat();

          // Publish the raw stream part as JSON so consumers can switch on
          // the native AI SDK type. Accumulation below is for the final
          // assembled result this activity returns.
          events.publish(encoder.encode(JSON.stringify(part)));

          switch (part.type) {
            case 'stream-start':
              warnings.push(...part.warnings);
              break;
            case 'text-start':
              currentText = '';
              break;
            case 'text-delta':
              currentText += part.delta;
              break;
            case 'text-end':
              content.push({
                type: 'text',
                text: currentText,
                providerMetadata: part.providerMetadata,
              });
              break;
            case 'reasoning-start':
              currentReasoning = '';
              break;
            case 'reasoning-delta':
              currentReasoning += part.delta;
              break;
            case 'reasoning-end':
              content.push({
                type: 'reasoning',
                text: currentReasoning,
                providerMetadata: part.providerMetadata,
              });
              break;
            case 'response-metadata':
              responseMetadata = {
                id: part.id,
                timestamp: part.timestamp,
                modelId: part.modelId,
              };
              break;
            case 'finish':
              finishReason = part.finishReason;
              usage = part.usage;
              break;
            default:
              // tool-call, tool-result, file, source — collect as content
              if (
                'type' in part &&
                (part.type === 'tool-call' ||
                  part.type === 'tool-result' ||
                  part.type === 'file' ||
                  part.type === 'source')
              ) {
                content.push(part as LanguageModelV3Content);
              }
              break;
          }
        }
      } finally {
        await stream.stop();
      }

      return {
        content,
        finishReason,
        usage,
        warnings,
        request: streamResult.request,
        response: responseMetadata
          ? { ...responseMetadata, ...streamResult.response }
          : streamResult.response,
      } as InvokeModelResult;
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
            // Convert the FlexibleSchema to a Schema so that the shape is known outside the activity
            inputSchema: asSchema(v.inputSchema),
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
      return await tool.execute(args.input, args.options);
    } finally {
      await mcpClient.close();
    }
  }
  return {
    [name + '-listTools']: listToolsActivity,
    [name + '-callTool']: callToolActivity,
  };
}
