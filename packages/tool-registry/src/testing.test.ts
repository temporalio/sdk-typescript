/**
 * Unit tests for testing utilities.
 * Runs without an API key or Temporal server.
 */

import assert from 'assert';
import { ToolRegistry } from './registry';
import {
  CrashAfterTurns,
  FakeToolRegistry,
  MockAgenticSession,
  MockProvider,
  ResponseBuilder,
} from './testing';

// ── MockProvider ───────────────────────────────────────────────────────────────

describe('MockProvider', () => {
  it('dispatches tool calls and runs loop to completion', async () => {
    const collected: string[] = [];
    const registry = new ToolRegistry();
    registry.define(
      { name: 'collect', description: 'd', input_schema: {} },
      (inp) => {
        collected.push(inp['value'] as string);
        return 'ok';
      }
    );

    const provider = new MockProvider([
      ResponseBuilder.toolCall('collect', { value: 'first' }),
      ResponseBuilder.toolCall('collect', { value: 'second' }),
      ResponseBuilder.done('all done'),
    ]);
    const messages = [{ role: 'user', content: 'go' }];
    await provider.runLoop(messages, registry);

    assert.deepStrictEqual(collected, ['first', 'second']);
  });

  it('stops on done response', async () => {
    const provider = new MockProvider([ResponseBuilder.done('finished')]);
    const messages = [{ role: 'user', content: 'x' }];
    await provider.runLoop(messages);
    // user + assistant
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[1]['role'], 'assistant');
  });

  it('stops cleanly when responses are exhausted', async () => {
    const provider = new MockProvider([]);
    const messages = [{ role: 'user', content: 'x' }];
    await provider.runLoop(messages);
    assert.strictEqual(messages.length, 1);
  });
});

// ── FakeToolRegistry ───────────────────────────────────────────────────────────

describe('FakeToolRegistry', () => {
  it('records all dispatch calls', () => {
    const fake = new FakeToolRegistry();
    fake.define({ name: 'greet', description: 'd', input_schema: {} }, () => 'ok');

    fake.dispatch('greet', { name: 'world' });
    fake.dispatch('greet', { name: 'temporal' });

    assert.deepStrictEqual(fake.calls, [
      ['greet', { name: 'world' }],
      ['greet', { name: 'temporal' }],
    ]);
  });

  it('still dispatches to the registered handler', () => {
    const fake = new FakeToolRegistry();
    fake.define({ name: 'echo', description: 'd', input_schema: {} }, (inp) => inp['v'] as string);
    assert.strictEqual(fake.dispatch('echo', { v: 'hello' }), 'hello');
  });
});

// ── CrashAfterTurns ───────────────────────────────────────────────────────────

describe('CrashAfterTurns', () => {
  it('throws after exactly n turns', async () => {
    const crasher = new CrashAfterTurns(1);
    const messages = [{ role: 'user', content: 'x' }];
    await crasher.runTurn(messages, new ToolRegistry()); // first turn: fine
    await assert.rejects(
      () => crasher.runTurn(messages, new ToolRegistry()),
      /simulated crash/
    );
  });

  it('completes n turns before crashing', async () => {
    const crasher = new CrashAfterTurns(2);
    const messages = [{ role: 'user', content: 'x' }];
    await crasher.runTurn(messages, new ToolRegistry());
    await crasher.runTurn(messages, new ToolRegistry());
    await assert.rejects(
      () => crasher.runTurn(messages, new ToolRegistry()),
      /simulated crash/
    );
  });
});

// ── MockAgenticSession ────────────────────────────────────────────────────────

describe('MockAgenticSession', () => {
  it('returns pre-canned issues without LLM calls', async () => {
    const session = new MockAgenticSession([{ type: 'deprecated', symbol: 'old_fn' }]);
    await session.runToolLoop({
      registry: new ToolRegistry(),
      provider: 'anthropic',
      system: 's',
      prompt: 'p',
    });
    assert.strictEqual(session.issues.length, 1);
    assert.strictEqual((session.issues[0] as Record<string, string>)['symbol'], 'old_fn');
  });

  it('starts empty when no issues provided', () => {
    const session = new MockAgenticSession();
    assert.deepStrictEqual(session.issues, []);
  });

  it('does not mutate the input issues array', () => {
    const input = [{ v: 1 }];
    const session = new MockAgenticSession(input);
    (session.issues as unknown[]).push({ v: 2 });
    assert.strictEqual(input.length, 1);
  });
});
