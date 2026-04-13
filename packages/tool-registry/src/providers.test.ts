/**
 * Unit tests for provider implementations and runToolLoop.
 * Runs without an API key — LLM calls are mocked.
 */

import assert from 'assert';
import { ToolRegistry } from './registry';
import { AnthropicProvider, OpenAIProvider, runToolLoop } from './providers';

// ── Mock client helpers ────────────────────────────────────────────────────────

function makeAnthropicClient(responses: Array<{ content: unknown[]; stop_reason: string }>) {
  let idx = 0;
  return {
    messages: {
      create: async (_opts: unknown) => {
        if (idx >= responses.length) return { content: [], stop_reason: 'end_turn' };
        return responses[idx++];
      },
    },
  };
}

function makeOpenAIClient(
  responses: Array<{
    choices: Array<{
      message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      finish_reason: string;
    }>;
  }>
) {
  let idx = 0;
  return {
    chat: {
      completions: {
        create: async (_opts: unknown) => {
          if (idx >= responses.length) return { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] };
          return responses[idx++];
        },
      },
    },
  };
}

// ── AnthropicProvider tests ────────────────────────────────────────────────────

describe('AnthropicProvider', () => {
  it('runs to completion when model returns end_turn immediately', async () => {
    const registry = new ToolRegistry();
    const client = makeAnthropicClient([{ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }]);
    const provider = new AnthropicProvider(registry, 'system', { client });

    const messages = [{ role: 'user', content: 'go' }];
    await provider.runLoop(messages);

    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[1]['role'], 'assistant');
  });

  it('dispatches tool calls and continues', async () => {
    const collected: string[] = [];
    const registry = new ToolRegistry();
    registry.define({ name: 'flag', description: 'd', input_schema: {} }, (inp) => {
      collected.push(inp['value'] as string);
      return 'recorded';
    });

    const client = makeAnthropicClient([
      {
        content: [{ type: 'tool_use', id: 'c1', name: 'flag', input: { value: 'hello' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);
    const provider = new AnthropicProvider(registry, 'sys', { client });

    const messages = [{ role: 'user', content: 'go' }];
    await provider.runLoop(messages);

    assert.deepStrictEqual(collected, ['hello']);
    // messages: user + assistant(tool_use) + user(tool_result) + assistant(done)
    assert.strictEqual(messages.length, 4);
  });
});

// ── OpenAIProvider tests ────────────────────────────────────────────────────────

describe('OpenAIProvider', () => {
  it('runs to completion on stop immediately', async () => {
    const registry = new ToolRegistry();
    const client = makeOpenAIClient([
      { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] },
    ]);
    const provider = new OpenAIProvider(registry, 'system', { client });

    const messages = [{ role: 'user', content: 'go' }];
    await provider.runLoop(messages);

    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[1]['role'], 'assistant');
  });

  it('dispatches function calls and continues', async () => {
    const collected: string[] = [];
    const registry = new ToolRegistry();
    registry.define({ name: 'record', description: 'd', input_schema: {} }, (inp) => {
      collected.push(inp['val'] as string);
      return 'ok';
    });

    const client = makeOpenAIClient([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'tc1', function: { name: 'record', arguments: '{"val":"world"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] },
    ]);
    const provider = new OpenAIProvider(registry, 'sys', { client });

    const messages = [{ role: 'user', content: 'go' }];
    await provider.runLoop(messages);

    assert.deepStrictEqual(collected, ['world']);
    assert.strictEqual(messages.length, 4); // user + assistant(fn) + tool + assistant(done)
  });
});

// ── runToolLoop tests ──────────────────────────────────────────────────────────

describe('runToolLoop', () => {
  it('throws for unknown provider', async () => {
    await assert.rejects(
      () =>
        runToolLoop({
          provider: 'gemini',
          system: 's',
          prompt: 'p',
          tools: new ToolRegistry(),
        }),
      /gemini/
    );
  });

  it('prepends prompt as first user message when messages is empty', async () => {
    const client = makeAnthropicClient([{ content: [], stop_reason: 'end_turn' }]);
    const messages = await runToolLoop({
      provider: 'anthropic',
      system: 'sys',
      prompt: 'my prompt',
      tools: new ToolRegistry(),
      client,
    });
    assert.strictEqual((messages[0] as Record<string, unknown>)['content'], 'my prompt');
  });

  it('uses existing messages when provided', async () => {
    const client = makeAnthropicClient([{ content: [], stop_reason: 'end_turn' }]);
    const existing = [{ role: 'user', content: 'original' }];
    const messages = await runToolLoop({
      provider: 'anthropic',
      system: 'sys',
      prompt: 'ignored',
      tools: new ToolRegistry(),
      messages: [...existing],
      client,
    });
    assert.strictEqual((messages[0] as Record<string, unknown>)['content'], 'original');
  });
});

// ── is_error / handler error tests ────────────────────────────────────────────

describe('AnthropicProvider handler errors', () => {
  it('catches handler exception, sets is_error:true, does not crash', async () => {
    const registry = new ToolRegistry();
    registry.define({ name: 'boom', description: 'd', input_schema: {} }, () => {
      throw new Error('intentional failure');
    });

    const client = makeAnthropicClient([
      { content: [{ type: 'tool_use', id: 'c1', name: 'boom', input: {} }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);
    const provider = new AnthropicProvider(registry, 'sys', { client });

    const messages = [{ role: 'user', content: 'go' }];
    // Must not throw even though handler errors.
    await provider.runLoop(messages);

    // messages: user, assistant(tool_use), user(tool_result), assistant(done)
    assert.strictEqual(messages.length, 4);
    const toolResultWrapper = messages[2] as Record<string, unknown>;
    const toolResults = toolResultWrapper['content'] as Array<Record<string, unknown>>;
    assert.strictEqual(toolResults[0]['type'], 'tool_result');
    assert.strictEqual(toolResults[0]['is_error'], true);
    assert.ok((toolResults[0]['content'] as string).includes('intentional failure'));
  });

  it('does not set is_error on successful handler', async () => {
    const registry = new ToolRegistry();
    registry.define({ name: 'ok', description: 'd', input_schema: {} }, () => 'result');

    const client = makeAnthropicClient([
      { content: [{ type: 'tool_use', id: 'c1', name: 'ok', input: {} }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);
    const provider = new AnthropicProvider(registry, 'sys', { client });

    const messages = [{ role: 'user', content: 'go' }];
    await provider.runLoop(messages);

    const toolResultWrapper = messages[2] as Record<string, unknown>;
    const toolResults = toolResultWrapper['content'] as Array<Record<string, unknown>>;
    assert.ok(!('is_error' in toolResults[0]), 'is_error should not be present on success');
  });
});

describe('OpenAIProvider handler errors', () => {
  it('catches handler exception, does not crash', async () => {
    const registry = new ToolRegistry();
    registry.define({ name: 'boom', description: 'd', input_schema: {} }, () => {
      throw new Error('openai error test');
    });

    const client = makeOpenAIClient([
      {
        choices: [{
          message: { content: null, tool_calls: [{ id: 'tc1', function: { name: 'boom', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        }],
      },
      { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] },
    ]);
    const provider = new OpenAIProvider(registry, 'sys', { client });

    const messages = [{ role: 'user', content: 'go' }];
    await provider.runLoop(messages);

    // Tool result message should contain the error string.
    const toolMsg = messages[2] as Record<string, unknown>;
    assert.ok((toolMsg['content'] as string).includes('openai error test'));
  });
});

// ── Integration tests (skipped unless RUN_INTEGRATION_TESTS is set) ────────────

describe('integration', function () {
  before(function () {
    if (!process.env['RUN_INTEGRATION_TESTS']) this.skip();
  });

  function makeRecordRegistry(): { registry: ToolRegistry; collected: string[] } {
    const collected: string[] = [];
    const registry = new ToolRegistry();
    registry.define(
      {
        name: 'record',
        description: 'Record a value',
        input_schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
      (inp) => {
        collected.push(inp['value'] as string);
        return 'recorded';
      }
    );
    return { registry, collected };
  }

  it('Anthropic: dispatches record tool with real API call', async function () {
    this.timeout(30000);
    assert.ok(process.env['ANTHROPIC_API_KEY'], 'ANTHROPIC_API_KEY required');
    const { registry, collected } = makeRecordRegistry();
    await runToolLoop({
      provider: 'anthropic',
      system: "You must call record() exactly once with value='hello'.",
      prompt: "Please call the record tool with value='hello'.",
      tools: registry,
    });
    assert.ok(collected.includes('hello'), `expected 'hello' in ${JSON.stringify(collected)}`);
  });

  it('OpenAI: dispatches record tool with real API call', async function () {
    this.timeout(30000);
    assert.ok(process.env['OPENAI_API_KEY'], 'OPENAI_API_KEY required');
    const { registry, collected } = makeRecordRegistry();
    await runToolLoop({
      provider: 'openai',
      system: "You must call record() exactly once with value='hello'.",
      prompt: "Please call the record tool with value='hello'.",
      tools: registry,
    });
    assert.ok(collected.includes('hello'), `expected 'hello' in ${JSON.stringify(collected)}`);
  });
});
