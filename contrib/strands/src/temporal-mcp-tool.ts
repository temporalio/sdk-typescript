import { JsonBlock, TextBlock, Tool, ToolResultBlock } from '@strands-agents/sdk';
import type { JSONValue, ToolContext, ToolSpec, ToolStreamGenerator } from '@strands-agents/sdk';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import type { CallToolInput, McpToolInfo } from './temporal-mcp-client';
import { callToolActivityName } from './temporal-mcp-client';
import { toJsonSchema } from './json-schema';

/**
 * Workflow-side stub for a single MCP tool. Each invocation dispatches the
 * per-server `{server}-callTool` activity built by {@link StrandsPlugin}, then
 * maps the raw MCP result (`{ content: [...], isError }`) into Strands
 * content blocks.
 *
 * Text items map to {@link TextBlock}; everything else falls back to
 * {@link JsonBlock}. Richer mappings (images, embedded resources) would
 * require `McpTool`, which is bundled in `@strands-agents/sdk` but not
 * re-exported from its public index.
 */
export class TemporalMCPTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: ToolSpec;
  readonly server: string;
  private readonly activityOptions: ActivityOptions;

  constructor(server: string, info: McpToolInfo, activityOptions: ActivityOptions) {
    super();
    this.server = server;
    this.name = info.name;
    this.description = info.description || `Tool which performs ${info.name}`;
    this.toolSpec = {
      name: info.name,
      description: this.description,
      inputSchema: toJsonSchema(info.inputSchema),
    };
    this.activityOptions = activityOptions;
  }

  // eslint-disable-next-line require-yield
  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const { toolUseId, input } = toolContext.toolUse;
    const activities = workflow.proxyActivities<{
      [key: string]: (input: CallToolInput) => Promise<JSONValue>;
    }>({
      summary: this.name,
      startToCloseTimeout: '10 minutes',
      ...this.activityOptions,
    });
    try {
      const raw = await activities[callToolActivityName(this.server)]!({
        toolName: this.name,
        args: input,
      });
      const result = raw as { content?: unknown[]; isError?: boolean } | null;
      if (result === null || typeof result !== 'object' || !Array.isArray(result.content)) {
        return new ToolResultBlock({
          toolUseId,
          status: 'error',
          content: [new TextBlock('Invalid MCP tool result: missing content array')],
        });
      }
      const content = result.content.length
        ? result.content.map(mapMcpContent)
        : [new TextBlock('Tool execution completed successfully with no output.')];
      return new ToolResultBlock({
        toolUseId,
        status: result.isError ? 'error' : 'success',
        content,
      });
    } catch (err) {
      return new ToolResultBlock({
        toolUseId,
        status: 'error',
        content: [new TextBlock(String(err instanceof Error ? err.message : err))],
      });
    }
  }
}

function mapMcpContent(item: unknown): TextBlock | JsonBlock {
  if (typeof item === 'object' && item !== null) {
    const obj = item as { type?: unknown; text?: unknown };
    if (obj.type === 'text' && typeof obj.text === 'string') {
      return new TextBlock(obj.text);
    }
  }
  return new JsonBlock({ json: item as JSONValue });
}
