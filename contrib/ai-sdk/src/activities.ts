import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Usage,
  EmbeddingModelV4Result,
  SharedV4ProviderOptions,
  SharedV4Headers,
  SharedV4Warning,
  ProviderV4,
} from '@ai-sdk/provider';
import { asSchema, type Schema, type ToolExecutionOptions } from 'ai';
import { ApplicationFailure } from '@temporalio/common';
import { Context } from '@temporalio/activity';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';
import type { Duration } from '@temporalio/common/lib/time';
import type { McpClientFactories, McpClientFactory } from './mcp';

const encoder = new TextEncoder();

/**
 * Arguments for invoking a language model activity.
 */
export interface InvokeModelArgs {
  modelId: string;
  options: LanguageModelV4CallOptions;
}

/**
 * Arguments for invoking a streaming language model activity.
 */
export interface InvokeModelStreamingArgs extends InvokeModelArgs {
  modelId: string;
  options: LanguageModelV4CallOptions;
  streamingTopic: string;
  streamingBatchInterval?: Duration;
}

/**
 * Result from a language model invocation.
 * This is an alias to the AI SDK's LanguageModelV4GenerateResult for type safety.
 */
export type InvokeModelResult = LanguageModelV4GenerateResult;

/**
 * Arguments for invoking an embedding model activity.
 * Note: AbortSignal is not included as it cannot be serialized across activity boundaries.
 * Temporal's workflow cancellation provides equivalent functionality.
 */
export interface InvokeEmbeddingModelArgs {
  modelId: string;
  values: string[];
  providerOptions?: SharedV4ProviderOptions;
  headers?: SharedV4Headers;
}

/**
 * Result from an embedding model invocation.
 * This is an alias to the AI SDK's EmbeddingModelV4Result for type safety.
 */
export type InvokeEmbeddingModelResult = EmbeddingModelV4Result;

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
  options: ToolExecutionOptions<unknown>;
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
export function createActivities(provider: ProviderV4, mcpClientFactories?: McpClientFactories): object {
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
     * `LanguageModelV4GenerateResult`. Consumers receive native AI SDK
     * stream-part types (text-delta, reasoning-delta, tool-input-delta,
     * response-metadata, finish, ...) and must tolerate part types they
     * don't recognize; no normalization happens here.
     */
    async invokeModelStreaming(args: InvokeModelStreamingArgs): Promise<InvokeModelResult> {
      await using stream = WorkflowStreamClient.fromWithinActivity({
        batchInterval: args.streamingBatchInterval ?? '100 milliseconds',
      });
      const events = stream.topic(args.streamingTopic);

      const model = provider.languageModel(args.modelId);
      const streamResult = await model.doStream(args.options);

      const content: LanguageModelV4Content[] = [];
      let finishReason: LanguageModelV4FinishReason = { unified: 'other', raw: undefined };
      let usage: LanguageModelV4Usage = {
        inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      };
      const warnings: SharedV4Warning[] = [];
      let responseMetadata: Record<string, unknown> | undefined;
      let sawFinish = false;
      let sawError = false;
      let streamError: unknown;

      const textBlocks = new Map<string, string>();
      const reasoningBlocks = new Map<string, string>();

      const reader = streamResult.stream.getReader();

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
            textBlocks.set(part.id, '');
            break;
          case 'text-delta':
            textBlocks.set(part.id, (textBlocks.get(part.id) ?? '') + part.delta);
            break;
          case 'text-end':
            content.push({
              type: 'text',
              text: textBlocks.get(part.id) ?? '',
              providerMetadata: part.providerMetadata,
            });
            textBlocks.delete(part.id);
            break;
          case 'reasoning-start':
            reasoningBlocks.set(part.id, '');
            break;
          case 'reasoning-delta':
            reasoningBlocks.set(part.id, (reasoningBlocks.get(part.id) ?? '') + part.delta);
            break;
          case 'reasoning-end':
            content.push({
              type: 'reasoning',
              text: reasoningBlocks.get(part.id) ?? '',
              providerMetadata: part.providerMetadata,
            });
            reasoningBlocks.delete(part.id);
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
            sawFinish = true;
            break;
          case 'raw':
            // Provider-specific raw chunks are published above but not part of the assembled result.
            break;
          case 'error':
            sawError = true;
            streamError = part.error;
            break;
          default:
            // tool-call, tool-result, file, source, reasoning-file, custom,
            // tool-approval-request — collect as content (stream-part and
            // content shapes are identical for these types)
            if (
              'type' in part &&
              (part.type === 'tool-call' ||
                part.type === 'tool-result' ||
                part.type === 'file' ||
                part.type === 'source' ||
                part.type === 'reasoning-file' ||
                part.type === 'custom' ||
                part.type === 'tool-approval-request')
            ) {
              content.push(part);
            }
            break;
        }
      }

      // An `error` part signals a provider failure even when the stream still delivers a
      // `finish` part afterwards — fail the activity rather than return a partial result as
      // success. `part.error` is untyped, so it cannot be classified as deterministic here;
      // surface it as retryable and let the activity retry policy govern, matching how a
      // provider error thrown from `doGenerate` behaves in the non-streaming activity.
      if (sawError) {
        throw ApplicationFailure.retryable(
          `Model stream emitted an error part${sawFinish ? '' : ' and ended without a finish part'}: ${streamError}`
        );
      }

      return {
        content,
        finishReason,
        usage,
        warnings,
        request: streamResult.request,
        response: responseMetadata ? { ...responseMetadata, ...streamResult.response } : streamResult.response,
      };
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
            // Function-valued descriptions (resolved per tool context) cannot cross the
            // activity boundary; only plain strings are preserved.
            description: typeof v.description === 'string' ? v.description : undefined,
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
