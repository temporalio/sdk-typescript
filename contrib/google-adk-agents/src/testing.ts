/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Test helpers for users adopting the Google ADK Temporal plugin.
 *
 * These let you unit-test Workflows that use `TemporalModel` / `TemporalMcpToolSet`
 * without booting a worker against a real Gemini endpoint or a real MCP server.
 * Import from the `./testing` subpath:
 *
 *   import { FakeLlm, fakeModelProvider, mockMcpToolset } from
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

import type { McpToolsetFactory } from './mcp.js';

/**
 * A deterministic {@link BaseLlm} test double. Yields the provided
 * `responses`, or a single canned text response if none are given. Registered
 * for model names matching `fake*` / `fake-model`.
 *
 * @experimental
 */
export class FakeLlm extends BaseLlm {
  /** Model-name patterns this fake resolves for in the ADK registry. */
  static override readonly supportedModels: Array<string | RegExp> = [/^fake.*/, 'fake-model'];

  private readonly responses?: LlmResponse[];

  /**
   * @param params    `{ model }` — the model name (default `'fake-model'`).
   * @param responses Optional canned responses to yield in order.
   */
  constructor(params: { model: string } = { model: 'fake-model' }, responses?: LlmResponse[]) {
    super({ model: params.model });
    this.responses = responses;
  }

  /** Yields the canned responses (or a default text response). */
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

  /** Not supported by the fake. */
  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('FakeLlm does not support connect().');
  }
}

/**
 * Returns a `modelProvider` (for `GoogleAdkPluginOptions.modelProvider`) that
 * resolves every model name to a {@link FakeLlm} yielding `responses`.
 *
 * @experimental
 */
export function fakeModelProvider(responses?: LlmResponse[]): (model: string) => BaseLlm {
  return (model: string) => new FakeLlm({ model }, responses);
}

/** A single tool definition for {@link mockMcpToolset}. @experimental */
export interface MockMcpToolDefinition {
  /** The tool's full declaration (name + description + parameter schema). */
  declaration: FunctionDeclaration;
  /** Handler invoked for a tool call; receives the call arguments. */
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/**
 * An in-memory {@link BaseToolset} test double for MCP. Use via
 * {@link mockMcpToolset} as a `GoogleAdkPluginOptions.mcpToolsets` factory.
 */
class MockMcpToolset extends BaseToolset {
  private readonly definitions: MockMcpToolDefinition[];

  /** @param definitions The tools this mock server exposes. */
  constructor(definitions: MockMcpToolDefinition[]) {
    super([]);
    this.definitions = definitions;
  }

  /** Returns the in-memory tools. */
  override async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.definitions.map((def) => new MockMcpTool(def));
  }

  /** No-op. */
  override async close(): Promise<void> {
    /* nothing to close */
  }
}

class MockMcpTool extends BaseTool {
  private readonly declaration: FunctionDeclaration;
  private readonly handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;

  constructor(def: MockMcpToolDefinition) {
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
 * Returns an {@link McpToolsetFactory} that produces a {@link MockMcpToolset}
 * — drop into `GoogleAdkPluginOptions.mcpToolsets` to test MCP routing without
 * a real server.
 *
 * @experimental
 */
export function mockMcpToolset(definitions: MockMcpToolDefinition[]): McpToolsetFactory {
  return () => new MockMcpToolset(definitions);
}
