/**
 * LLM provider implementations for ToolRegistry.
 *
 * Provides {@link AnthropicProvider} and {@link OpenAIProvider}, each
 * implementing a complete multi-turn tool-calling loop. The top-level
 * {@link runToolLoop} function constructs the appropriate provider and runs
 * the loop.
 *
 * Both providers follow the same protocol:
 * 1. Send messages + tool definitions to the model.
 * 2. If the model returns tool_use / function blocks, dispatch each tool call
 *    via {@link ToolRegistry.dispatch} and append the result.
 * 3. Repeat until the model stops requesting tool calls.
 */

import type { ToolRegistry } from './registry';

/** A single message in the conversation history. */
export type Message = Record<string, unknown>;

/** Options for {@link runToolLoop}. */
export interface RunToolLoopOptions {
  /** LLM provider: "anthropic" or "openai". */
  provider: string;
  /** System prompt. */
  system: string;
  /** Initial user message. */
  prompt: string;
  /** Registered tool handlers. */
  tools: ToolRegistry;
  /** Existing message history to continue from. Prompt is ignored if provided. */
  messages?: Message[];
  /** Model name override. */
  model?: string;
  /** Pre-constructed LLM client (useful in tests). */
  client?: unknown;
}

/**
 * Anthropic multi-turn tool-calling loop.
 *
 * @experimental Provider classes are internal implementation details.
 * Prefer {@link runToolLoop} or {@link AgenticSession.runToolLoop} as the
 * public entry point.
 */
export class AnthropicProvider {
  private readonly _client: {
    messages: {
      create: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };

  constructor(
    private readonly _registry: ToolRegistry,
    private readonly _system: string,
    options: { model?: string; client?: unknown } = {}
  ) {
    this._model = options.model ?? 'claude-sonnet-4-6';
    if (options.client != null) {
      this._client = options.client as typeof this._client;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Anthropic = require('@anthropic-ai/sdk');
      this._client = new Anthropic.default({ apiKey: process.env['ANTHROPIC_API_KEY'] });
    }
  }

  private readonly _model: string;

  /**
   * Execute one turn of the conversation.
   *
   * Appends the assistant response (and any tool results) to `messages` in-place.
   *
   * @returns `true` when the loop should stop, `false` to continue.
   */
  async runTurn(messages: Message[]): Promise<boolean> {
    const response = (await this._client.messages.create({
      model: this._model,
      max_tokens: 4096,
      system: this._system,
      tools: this._registry.toAnthropic(),
      messages,
    })) as {
      content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      stop_reason: string;
    };

    // Convert content blocks to plain objects (Anthropic SDK returns Pydantic-style objects)
    const assistantContent = response.content.map((block) => ({ ...block }));
    messages.push({ role: 'assistant', content: assistantContent });

    const toolCalls = assistantContent.filter((b) => b['type'] === 'tool_use');
    if (toolCalls.length === 0 || response.stop_reason === 'end_turn') {
      return true;
    }

    const toolResults = toolCalls.map((call) => ({
      type: 'tool_result',
      tool_use_id: call['id'],
      content: this._registry.dispatch(call['name'] as string, (call['input'] ?? {}) as Record<string, unknown>),
    }));
    messages.push({ role: 'user', content: toolResults });
    return false;
  }

  /** Run turns until the model stops requesting tools. */
  async runLoop(messages: Message[]): Promise<void> {
    while (!(await this.runTurn(messages))) {
      // continue
    }
  }
}

/**
 * OpenAI multi-turn function-calling loop.
 *
 * @experimental Provider classes are internal implementation details.
 * Prefer {@link runToolLoop} as the public entry point.
 */
export class OpenAIProvider {
  private readonly _client: {
    chat: {
      completions: {
        create: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
    };
  };

  constructor(
    private readonly _registry: ToolRegistry,
    private readonly _system: string,
    options: { model?: string; client?: unknown } = {}
  ) {
    this._model = options.model ?? 'gpt-4o';
    if (options.client != null) {
      this._client = options.client as typeof this._client;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const OpenAI = require('openai');
      this._client = new OpenAI.default({ apiKey: process.env['OPENAI_API_KEY'] });
    }
  }

  private readonly _model: string;

  /**
   * Execute one turn of the conversation.
   *
   * @returns `true` when the loop should stop, `false` to continue.
   */
  async runTurn(messages: Message[]): Promise<boolean> {
    const fullMessages = [{ role: 'system', content: this._system }, ...messages];
    const response = (await this._client.chat.completions.create({
      model: this._model,
      tools: this._registry.toOpenAI(),
      messages: fullMessages,
    })) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
    };

    const choice = response.choices[0];
    if (choice == null) return true;

    const msg: Message = { role: 'assistant', content: choice.message.content };
    if (choice.message.tool_calls != null) {
      msg['tool_calls'] = choice.message.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }
    messages.push(msg);

    if (!choice.message.tool_calls?.length || ['stop', 'length'].includes(choice.finish_reason)) {
      return true;
    }

    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      const result = this._registry.dispatch(tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
    return false;
  }

  /** Run turns until the model stops calling functions. */
  async runLoop(messages: Message[]): Promise<void> {
    while (!(await this.runTurn(messages))) {
      // continue
    }
  }
}

/**
 * Run a complete multi-turn LLM tool-calling loop.
 *
 * This is the primary entry point for simple (non-resumable) tool loops.
 * For resumable agentic sessions with crash-safe heartbeating, use
 * {@link AgenticSession} via {@link agenticSession}.
 *
 * @returns The final messages list with the complete conversation history.
 * @throws {Error} If `provider` is not "anthropic" or "openai".
 */
export async function runToolLoop(options: RunToolLoopOptions): Promise<Message[]> {
  const { provider, system, prompt, tools, model, client } = options;
  const messages: Message[] = options.messages ?? [{ role: 'user', content: prompt }];
  if (messages.length === 0) {
    messages.push({ role: 'user', content: prompt });
  }

  const providerOpts = { model, client };

  if (provider === 'anthropic') {
    const p = new AnthropicProvider(tools, system, providerOpts);
    await p.runLoop(messages);
  } else if (provider === 'openai') {
    const p = new OpenAIProvider(tools, system, providerOpts);
    await p.runLoop(messages);
  } else {
    throw new Error(`Unknown provider ${JSON.stringify(provider)}. Use 'anthropic' or 'openai'.`);
  }

  return messages;
}
