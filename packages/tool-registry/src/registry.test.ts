/**
 * Unit tests for ToolRegistry.
 * Runs without an API key or Temporal server.
 */

import assert from 'assert';
import { ToolRegistry } from './registry';

describe('ToolRegistry', () => {
  it('dispatches to the registered handler', async () => {
    const registry = new ToolRegistry();
    registry.define(
      { name: 'greet', description: 'd', input_schema: {} },
      (inp) => `hello ${inp['name']}`
    );
    assert.strictEqual(await registry.dispatch('greet', { name: 'world' }), 'hello world');
  });

  it('rejects for unknown tool names', async () => {
    const registry = new ToolRegistry();
    await assert.rejects(() => registry.dispatch('missing', {}), /Unknown tool/);
  });

  it('dispatches async handlers and awaits the result', async () => {
    const registry = new ToolRegistry();
    registry.define(
      { name: 'async_greet', description: 'd', input_schema: {} },
      async (inp) => `async hello ${inp['name']}`
    );
    assert.strictEqual(await registry.dispatch('async_greet', { name: 'world' }), 'async hello world');
  });

  it('exports definitions in OpenAI format', () => {
    const registry = new ToolRegistry();
    registry.define(
      {
        name: 'my_tool',
        description: 'does something',
        input_schema: { type: 'object', properties: { x: { type: 'string' } } },
      },
      () => 'ok'
    );
    const result = registry.toOpenAI();
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].type, 'function');
    assert.strictEqual(result[0].function.name, 'my_tool');
    assert.strictEqual(result[0].function.description, 'does something');
    assert.deepStrictEqual(result[0].function.parameters, {
      type: 'object',
      properties: { x: { type: 'string' } },
    });
  });

  it('toAnthropic returns definitions unchanged', () => {
    const defn = { name: 't', description: 'd', input_schema: {} };
    const registry = new ToolRegistry();
    registry.define(defn, () => 'ok');
    assert.deepStrictEqual(registry.toAnthropic(), [defn]);
  });

  it('exports multiple tools', () => {
    const registry = new ToolRegistry();
    registry.define({ name: 'alpha', description: 'a', input_schema: {} }, () => 'a');
    registry.define({ name: 'beta', description: 'b', input_schema: {} }, () => 'b');
    const result = registry.toOpenAI();
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].function.name, 'alpha');
    assert.strictEqual(result[1].function.name, 'beta');
  });

  it('fromMcpTools wraps MCP tool descriptors', async () => {
    const mcpTools = [
      { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
      { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} } },
    ];
    const registry = ToolRegistry.fromMcpTools(mcpTools);
    const names = registry.toAnthropic().map((d) => d.name);
    assert.deepStrictEqual(names, ['search', 'read']);
    // No-op handlers return empty string
    assert.strictEqual(await registry.dispatch('search', {}), '');
  });
});
