/**
 * @temporalio/tool-registry — LLM tool-calling primitives for Temporal activities.
 *
 * Define tools once with {@link ToolRegistry}, export provider-specific schemas
 * for Anthropic or OpenAI, and run complete multi-turn tool-calling conversations
 * with {@link runToolLoop}.
 *
 * For crash-safe multi-turn sessions that survive activity retries, use
 * {@link agenticSession} (exported from `./session`).
 *
 * @example
 * ```typescript
 * import { ToolRegistry, runToolLoop } from '@temporalio/tool-registry';
 *
 * const tools = new ToolRegistry();
 * const issues: string[] = [];
 *
 * tools.define(
 *   { name: 'flag', description: 'Flag an issue', input_schema: { ... } },
 *   (inp) => { issues.push(inp.description as string); return 'recorded'; }
 * );
 *
 * await runToolLoop({
 *   provider: 'anthropic',
 *   system: 'You are a code reviewer...',
 *   prompt: 'Review this code...',
 *   tools,
 * });
 * ```
 */

export { ToolRegistry } from './registry';
export type { ToolDefinition, ToolHandler, McpToolDescriptor } from './registry';
export { AnthropicProvider, OpenAIProvider, runToolLoop } from './providers';
export type { Message, RunToolLoopOptions as ProviderRunLoopOptions } from './providers';
export { ToolRegistryPlugin } from './plugin';
export type { ToolRegistryPluginOptions } from './plugin';
export { registryFromMcpTools } from './mcp';
export type { McpTool } from './mcp';
export { AgenticSession, agenticSession } from './session';
export type { RunToolLoopOptions } from './session';
export { ResponseBuilder, MockProvider, FakeToolRegistry, MockAgenticSession, CrashAfterTurns } from './testing';
export type { MockResponse } from './testing';
