/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Test helpers for users adopting the Google ADK Temporal plugin.
 *
 * These let you unit-test Workflows that use `TemporalModel` / `TemporalMCPToolset`
 * without booting a worker against a real Gemini endpoint or a real MCP server.
 * Import from the `./testing` subpath:
 *
 *   import { FakeLlm, fakeModelProvider, mockMCPToolset } from
 *     '@temporalio/google-adk-agents/testing';
 */

import type { FunctionDeclaration } from '@google/genai';
import {
  BaseLlm,
  BaseToolset,
  BaseTool,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
  type ReadonlyContext,
  type RunAsyncToolRequest,
} from '@google/adk';

import type { MCPToolsetFactory } from './mcp.js';

/**
 * A deterministic {@link BaseLlm} test double. Yields the provided
 * `responses`, or a single canned text response if none are given. Registered
 * for model names matching `fake*` / `fake-model`.
 */
export class FakeLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [/^fake.*/, 'fake-model'];

  private readonly responses?: LlmResponse[];

  /**
   * @param options `model` — the model name (default `'fake-model'`) — and
   *                optional canned `responses` to yield in order.
   */
  constructor(options: { model?: string; responses?: LlmResponse[] } = {}) {
    super({ model: options.model ?? 'fake-model' });
    this.responses = options.responses;
  }

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream = false,
    _abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    const out: LlmResponse[] = this.responses ?? [
      {
        content: { role: 'model', parts: [{ text: `fake-response:${this.model}` }] },
        turnComplete: true,
      },
    ];
    for (const response of out) {
      yield response;
    }
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('FakeLlm does not support connect().');
  }
}

/**
 * Returns a `modelProvider` (for `GoogleAdkPluginOptions.modelProvider`) that
 * resolves every model name to a {@link FakeLlm} yielding `responses`.
 */
export function fakeModelProvider(responses?: LlmResponse[]): (model: string) => BaseLlm {
  return (model: string) => new FakeLlm({ model, responses });
}

/** A single tool definition for {@link mockMCPToolset}. */
export interface MockMCPToolDefinition {
  /** The tool's full declaration (name + description + parameter schema). */
  declaration: FunctionDeclaration;
  /** Handler invoked for a tool call; receives the call arguments. */
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/**
 * An in-memory {@link BaseToolset} test double for MCP. Use via
 * {@link mockMCPToolset} as a `GoogleAdkPluginOptions.mcpToolsets` factory.
 */
class MockMCPToolset extends BaseToolset {
  private readonly definitions: MockMCPToolDefinition[];

  constructor(definitions: MockMCPToolDefinition[]) {
    super([]);
    this.definitions = definitions;
  }

  override async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.definitions.map((def) => new MockMCPTool(def));
  }

  override async close(): Promise<void> {}
}

class MockMCPTool extends BaseTool {
  private readonly declaration: FunctionDeclaration;
  private readonly handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;

  constructor(def: MockMCPToolDefinition) {
    super({ name: def.declaration.name ?? 'mock', description: def.declaration.description ?? '' });
    this.declaration = def.declaration;
    this.handler = def.handler;
  }

  override _getDeclaration(): FunctionDeclaration {
    return this.declaration;
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return this.handler(request.args);
  }
}

/**
 * Returns an {@link MCPToolsetFactory} that produces a {@link MockMCPToolset}
 * — drop into `GoogleAdkPluginOptions.mcpToolsets` to test MCP routing without
 * a real server.
 */
export function mockMCPToolset(definitions: MockMCPToolDefinition[]): MCPToolsetFactory {
  return () => new MockMCPToolset(definitions);
}
