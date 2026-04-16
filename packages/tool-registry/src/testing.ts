/**
 * Testing utilities for `@temporalio/tool-registry`.
 *
 * Provides mock objects that allow unit tests to exercise {@link ToolRegistry},
 * {@link AgenticSession}, and {@link runToolLoop} without an API key or a
 * running Temporal server. Also provides {@link MockAgenticSession} for testing
 * code that uses {@link agenticSession} without any LLM calls.
 *
 * @example
 * ```typescript
 * import { ToolRegistry } from '@temporalio/tool-registry';
 * import { MockProvider, ResponseBuilder } from '@temporalio/tool-registry';
 *
 * const provider = new MockProvider([
 *   ResponseBuilder.toolCall('flag_issue', { description: 'wrong' }),
 *   ResponseBuilder.done('Analysis complete.'),
 * ]);
 *
 * const messages = [{ role: 'user', content: 'analyze this' }];
 * await provider.runLoop(messages, registry);
 * ```
 */

import { ToolRegistry } from './registry';
import type { Message } from './providers';
import type { RunToolLoopOptions } from './session';

/** Internal shape of a scripted mock response produced by {@link ResponseBuilder}. */
export interface MockResponse {
  /** Whether this response ends the loop. */
  _mockStop: boolean;
  /** Content blocks returned as the assistant message. */
  content: Array<Record<string, unknown>>;
}

/**
 * Factories for scripting mock LLM turn sequences.
 *
 * @example
 * ```typescript
 * const provider = new MockProvider([
 *   ResponseBuilder.toolCall('greet', { name: 'world' }),
 *   ResponseBuilder.done('said hello'),
 * ]);
 * ```
 */
export class ResponseBuilder {
  /**
   * Create a mock assistant message that makes a single tool call.
   *
   * @param toolName - Name of the tool to call.
   * @param toolInput - Input passed to the tool.
   * @param callId - Optional tool-use ID. Auto-generated if omitted.
   */
  static toolCall(
    toolName: string,
    toolInput: Record<string, unknown>,
    callId?: string
  ): MockResponse {
    const id = callId ?? `test_${Math.random().toString(16).slice(2, 10)}`;
    return {
      _mockStop: false,
      content: [{ type: 'tool_use', id, name: toolName, input: toolInput }],
    };
  }

  /**
   * Create a mock assistant message that ends the loop.
   *
   * @param text - Assistant text response.
   */
  static done(text = 'Done.'): MockResponse {
    return {
      _mockStop: true,
      content: [{ type: 'text', text }],
    };
  }
}

/**
 * LLM provider that returns pre-scripted responses without API calls.
 *
 * Responses are consumed in order. Once exhausted the loop stops.
 *
 * @example
 * ```typescript
 * const provider = new MockProvider([
 *   ResponseBuilder.toolCall('greet', { name: 'world' }),
 *   ResponseBuilder.done('said hello'),
 * ]);
 * const messages = [{ role: 'user', content: 'greet world' }];
 * await provider.runLoop(messages, registry);
 * ```
 */
export class MockProvider {
  private _index = 0;

  constructor(private readonly _responses: MockResponse[]) {}

  /**
   * Execute one scripted turn.
   *
   * @returns `true` when done, `false` to continue.
   */
  async runTurn(messages: Message[], registry: ToolRegistry): Promise<boolean> {
    if (this._index >= this._responses.length) return true;

    const response = this._responses[this._index++];
    const { _mockStop: stop, content } = response;

    messages.push({ role: 'assistant', content });

    if (!stop) {
      const toolResults: Record<string, unknown>[] = [];
      for (const block of content) {
        if (block['type'] === 'tool_use') {
          const result = registry.dispatch(
            block['name'] as string,
            (block['input'] ?? {}) as Record<string, unknown>
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block['id'],
            content: result,
          });
        }
      }
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }
    }

    return stop;
  }

  /** Run all scripted turns until exhausted or a done response is reached. */
  async runLoop(messages: Message[], registry?: ToolRegistry): Promise<void> {
    const reg = registry ?? new ToolRegistry();
    while (!(await this.runTurn(messages, reg))) {
      // continue
    }
  }
}

/**
 * A {@link ToolRegistry} that records all dispatch calls.
 *
 * Useful for asserting which tools were called and with what inputs.
 *
 * @example
 * ```typescript
 * const fake = new FakeToolRegistry();
 * fake.define({ name: 'greet', description: 'd', input_schema: {} }, () => 'ok');
 * fake.dispatch('greet', { name: 'world' });
 * assert.deepStrictEqual(fake.calls, [['greet', { name: 'world' }]]);
 * ```
 */
export class FakeToolRegistry extends ToolRegistry {
  /** All recorded dispatch calls as `[name, input]` tuples. */
  readonly calls: Array<[string, Record<string, unknown>]> = [];

  async dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    this.calls.push([name, input]);
    return super.dispatch(name, input);
  }
}

/**
 * A pre-canned session that returns fixed results without LLM calls.
 *
 * Use this to test code that calls {@link agenticSession} and inspects
 * `session.results` without needing an API key or a running server.
 *
 * @example
 * ```typescript
 * const session = new MockAgenticSession([{ type: 'deprecated', symbol: 'old_fn' }]);
 * await session.runToolLoop({ registry, provider: 'anthropic', system: 's', prompt: 'p' });
 * assert.strictEqual(session.results.length, 1);
 * ```
 */
export class MockAgenticSession {
  messages: unknown[] = [];
  results: unknown[];

  constructor(results: unknown[] = []) {
    this.results = [...results];
  }

  /** No-op — does not call any LLM. */
  async runToolLoop(_opts: RunToolLoopOptions): Promise<void> {
    // results already set by constructor
  }

  /** No-op — does not call heartbeat() in tests. */
  _checkpoint(): void {
    // nothing
  }
}

/**
 * Simulates an activity crash after `n` turns.
 *
 * Use in integration tests to verify that {@link agenticSession} correctly
 * resumes from a checkpoint after a crash.
 *
 * @example
 * ```typescript
 * const crasher = new CrashAfterTurns(2);
 * // First two turns complete; third throws.
 * ```
 */
export class CrashAfterTurns {
  private _count = 0;

  constructor(private readonly _n: number) {}

  async runTurn(messages: Message[], _registry: ToolRegistry): Promise<boolean> {
    this._count++;
    if (this._count > this._n) {
      throw new Error(`CrashAfterTurns: simulated crash after ${this._n} turns`);
    }
    messages.push({ role: 'assistant', content: [{ type: 'text', text: '...' }] });
    return this._count >= this._n;
  }

  async runLoop(messages: Message[], registry?: ToolRegistry): Promise<void> {
    const reg = registry ?? new ToolRegistry();
    while (!(await this.runTurn(messages, reg))) {
      // continue
    }
  }
}
