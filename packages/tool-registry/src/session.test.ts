/**
 * Unit tests for AgenticSession and agenticSession.
 * Runs without an API key — heartbeat and activityInfo are mocked.
 */

import assert from 'assert';
import { AgenticSession, agenticSession } from './session';
import { ToolRegistry } from './registry';

// ── Mock helpers ───────────────────────────────────────────────────────────────

/**
 * Patch activityInfo and heartbeat for a test.
 * Returns the mocked heartbeat call list.
 */
function mockActivity(
  heartbeatDetails: unknown[] = []
): { heartbeatCalls: string[]; restore: () => void } {
  const heartbeatCalls: string[] = [];
  const activityModule = require('@temporalio/activity');

  const origInfo = activityModule.activityInfo;
  const origHeartbeat = activityModule.heartbeat;

  activityModule.activityInfo = () => ({ heartbeatDetails });
  activityModule.heartbeat = (s: string) => heartbeatCalls.push(s);

  return {
    heartbeatCalls,
    restore: () => {
      activityModule.activityInfo = origInfo;
      activityModule.heartbeat = origHeartbeat;
    },
  };
}

/**
 * Build a mock Anthropic client returning scripted responses.
 *
 * @param responses - list of bools: true=done (end_turn, no tools), false=continue (tool_use)
 */
function makeMockAnthropicClient(responses: boolean[], toolName = 'noop') {
  let idx = 0;
  return {
    messages: {
      create: async (_opts: unknown) => {
        const done = idx < responses.length ? (responses[idx++] ?? true) : true;
        if (done) {
          return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
        }
        return {
          content: [{ type: 'tool_use', id: 'tid', name: toolName, input: {} }],
          stop_reason: 'tool_use',
        };
      },
    },
  };
}

// ── AgenticSession constructor tests ──────────────────────────────────────────

describe('AgenticSession', () => {
  it('initializes with empty messages and issues by default', () => {
    const session = new AgenticSession();
    assert.deepStrictEqual(session.messages, []);
    assert.deepStrictEqual(session.issues, []);
  });

  it('restores messages and issues from saved state', () => {
    const state = {
      messages: [{ role: 'user', content: 'analyze this' }],
      issues: [{ type: 'missing', symbol: 'patched', description: 'removed' }],
    };
    const session = new AgenticSession(state);
    assert.deepStrictEqual(session.messages, state.messages);
    assert.strictEqual(session.issues.length, 1);
    assert.strictEqual((session.issues[0] as Record<string, string>)['type'], 'missing');
  });
});

// ── AgenticSession._checkpoint tests ──────────────────────────────────────────

describe('AgenticSession._checkpoint', () => {
  it('heartbeats JSON with messages and issues', () => {
    const { heartbeatCalls, restore } = mockActivity();
    try {
      const session = new AgenticSession({
        messages: [{ role: 'user', content: 'hi' }],
        issues: [{ type: 'deprecated', symbol: 'old', description: 'use new' }],
      });
      session._checkpoint();
    } finally {
      restore();
    }

    assert.strictEqual(heartbeatCalls.length, 1);
    const payload = JSON.parse(heartbeatCalls[0]);
    assert.strictEqual(payload.messages.length, 1);
    assert.strictEqual(payload.issues.length, 1);
    assert.strictEqual(payload.issues[0].symbol, 'old');
  });

  it('heartbeats valid empty JSON when state is empty', () => {
    const { heartbeatCalls, restore } = mockActivity();
    try {
      new AgenticSession()._checkpoint();
    } finally {
      restore();
    }

    const payload = JSON.parse(heartbeatCalls[0]);
    assert.deepStrictEqual(payload, { version: 1, messages: [], issues: [] });
  });
});

// ── AgenticSession.runToolLoop tests ──────────────────────────────────────────

describe('AgenticSession.runToolLoop', () => {
  it('adds prompt as first message on fresh start', async () => {
    const { restore } = mockActivity();
    const client = makeMockAnthropicClient([true]);

    try {
      const session = new AgenticSession();
      await session.runToolLoop({
        registry: new ToolRegistry(),
        provider: 'anthropic',
        system: 'sys',
        prompt: 'my prompt',
        client,
      });
      assert.strictEqual((session.messages[0] as Record<string, string>)['content'], 'my prompt');
    } finally {
      restore();
    }
  });

  it('does not add prompt when messages already present (resume)', async () => {
    const existing = [
      { role: 'user', content: 'original prompt' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ];
    const { restore } = mockActivity();
    const client = makeMockAnthropicClient([true]);

    try {
      const session = new AgenticSession({ messages: [...existing] });
      await session.runToolLoop({
        registry: new ToolRegistry(),
        provider: 'anthropic',
        system: 'sys',
        prompt: 'ignored',
        client,
      });
      assert.deepStrictEqual(session.messages.slice(0, 2), existing);
    } finally {
      restore();
    }
  });

  it('calls _checkpoint once per turn', async () => {
    const registry = new ToolRegistry();
    registry.define({ name: 'noop', description: 'd', input_schema: {} }, () => 'ok');

    const { restore } = mockActivity();
    // 3 turns: not-done, not-done, done
    const client = makeMockAnthropicClient([false, false, true], 'noop');
    let checkpointCount = 0;

    try {
      const session = new AgenticSession({ messages: [{ role: 'user', content: 'go' }] });
      const orig = session._checkpoint.bind(session);
      session._checkpoint = () => { checkpointCount++; orig(); };

      await session.runToolLoop({
        registry,
        provider: 'anthropic',
        system: 's',
        prompt: 'ignored',
        client,
      });
    } finally {
      restore();
    }

    assert.strictEqual(checkpointCount, 3);
  });

  it('throws for unknown provider', async () => {
    const { restore } = mockActivity();
    try {
      const session = new AgenticSession({ messages: [{ role: 'user', content: 'x' }] });
      await assert.rejects(
        () => session.runToolLoop({
          registry: new ToolRegistry(),
          provider: 'gemini',
          system: 's',
          prompt: 'p',
        }),
        /gemini/
      );
    } finally {
      restore();
    }
  });
});

// ── Checkpoint round-trip test (T6) ──────────────────────────────────────────

describe('AgenticSession checkpoint round-trip', () => {
  it('preserves tool_calls through JSON serialize/deserialize', () => {
    const { heartbeatCalls, restore } = mockActivity();
    try {
      const toolCallsInMemory = [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'my_tool', arguments: '{"x":1}' },
        },
      ];
      const session = new AgenticSession({
        messages: [{ role: 'assistant', tool_calls: toolCallsInMemory }],
        issues: [{ type: 'smell', file: 'foo.ts' }],
      });
      session._checkpoint();
    } finally {
      restore();
    }

    assert.strictEqual(heartbeatCalls.length, 1);
    const restored = JSON.parse(heartbeatCalls[0]);

    assert.strictEqual(restored.messages[0].role, 'assistant');
    const toolCallsRestored = restored.messages[0].tool_calls as Record<string, unknown>[];
    assert.strictEqual(toolCallsRestored.length, 1);
    assert.strictEqual(toolCallsRestored[0].id, 'call_abc');
    assert.strictEqual(
      (toolCallsRestored[0].function as Record<string, string>).name,
      'my_tool'
    );

    assert.strictEqual(restored.issues[0].type, 'smell');
    assert.strictEqual(restored.issues[0].file, 'foo.ts');
  });
});

// ── agenticSession function tests ─────────────────────────────────────────────

describe('agenticSession', () => {
  it('starts fresh with no heartbeat state', async () => {
    const { restore } = mockActivity([]);
    try {
      await agenticSession(async (session) => {
        assert.deepStrictEqual(session.messages, []);
        assert.deepStrictEqual(session.issues, []);
      });
    } finally {
      restore();
    }
  });

  it('restores from JSON checkpoint in heartbeatDetails', async () => {
    const saved = JSON.stringify({
      messages: [{ role: 'user', content: 'test' }],
      issues: [{ type: 'deprecated', symbol: 'old_api', description: 'use new_api' }],
    });
    const { restore } = mockActivity([saved]);
    try {
      await agenticSession(async (session) => {
        assert.strictEqual(session.messages.length, 1);
        assert.strictEqual(session.issues.length, 1);
        assert.strictEqual((session.issues[0] as Record<string, string>)['symbol'], 'old_api');
      });
    } finally {
      restore();
    }
  });

  it('starts fresh on corrupted checkpoint', async () => {
    const { restore } = mockActivity(['not valid json{{']);
    try {
      await agenticSession(async (session) => {
        assert.deepStrictEqual(session.messages, []);
        assert.deepStrictEqual(session.issues, []);
      });
    } finally {
      restore();
    }
  });

  it('returns the callback result', async () => {
    const { restore } = mockActivity([]);
    try {
      const result = await agenticSession(async (_session) => 'my result');
      assert.strictEqual(result, 'my result');
    } finally {
      restore();
    }
  });
});
