/**
 * ToolRegistry — define LLM tools once, export provider-specific schemas.
 *
 * A {@link ToolRegistry} stores a mapping from tool name to its definition (in
 * Anthropic's `tool_use` format) and a callable handler. The same registry can
 * be converted to Anthropic-format or OpenAI-format schemas for use with either
 * provider's client library, and dispatches incoming tool calls to the registered
 * handler.
 *
 * @example
 * ```typescript
 * const tools = new ToolRegistry();
 * tools.define(
 *   { name: 'flag_issue', description: '...', input_schema: { type: 'object', properties: { ... } } },
 *   (inp) => { issues.push(inp.description); return 'recorded'; }
 * );
 *
 * // Use with Anthropic
 * client.messages.create({ tools: tools.toAnthropic(), ... });
 *
 * // Use with OpenAI
 * client.chat.completions.create({ tools: tools.toOpenAI(), ... });
 *
 * // Dispatch a tool call returned by the model
 * const result = tools.dispatch(toolName, toolInput);
 * ```
 */

/** Anthropic-format tool definition. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Handler function type: receives parsed tool input, returns a string result or a Promise of one. */
export type ToolHandler = (input: Record<string, unknown>) => string | Promise<string>;

/** MCP-compatible tool descriptor (subset of mcp.Tool). */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Registry mapping tool names to definitions and handlers.
 *
 * Tools are registered in Anthropic's `tool_use` JSON format. The registry
 * can export the same tools for Anthropic or OpenAI providers, and dispatch
 * incoming tool calls to the appropriate handler.
 */
export class ToolRegistry {
  private readonly _definitions: ToolDefinition[] = [];
  private readonly _handlers = new Map<string, ToolHandler>();

  // ── Registration ────────────────────────────────────────────────────────────

  /**
   * Register a tool definition and its handler.
   *
   * @param definition - Tool definition in Anthropic `tool_use` format.
   * @param handler - Function called when the model invokes this tool.
   */
  define(definition: ToolDefinition, handler: ToolHandler): void {
    this._definitions.push(definition);
    this._handlers.set(definition.name, handler);
  }

  /**
   * Build a ToolRegistry from a list of MCP tool descriptors.
   *
   * Each MCP tool is wrapped with a no-op handler (returning an empty string).
   * Replace handlers via {@link define} as needed.
   *
   * @param tools - MCP tool objects with `name`, `description`, and `inputSchema`.
   */
  static fromMcpTools(tools: McpToolDescriptor[]): ToolRegistry {
    const registry = new ToolRegistry();
    for (const tool of tools) {
      registry.define(
        {
          name: tool.name,
          description: tool.description ?? '',
          input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
        },
        () => ''
      );
    }
    return registry;
  }

  // ── Schema export ────────────────────────────────────────────────────────────

  /**
   * Return tool definitions in Anthropic `tool_use` format.
   *
   * Definitions are returned exactly as registered — no conversion needed.
   */
  toAnthropic(): ToolDefinition[] {
    return [...this._definitions];
  }

  /**
   * Return tool definitions in OpenAI function-calling format.
   *
   * Converts each Anthropic-format definition to the
   * `{"type": "function", "function": {...}}` shape, mapping `input_schema`
   * to `parameters`.
   */
  toOpenAI(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return this._definitions.map((defn) => ({
      type: 'function' as const,
      function: {
        name: defn.name,
        description: defn.description,
        parameters: defn.input_schema,
      },
    }));
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────────

  /**
   * Call the handler registered for `name` with `input`.
   *
   * Supports both synchronous and asynchronous handlers.
   *
   * @param name - Tool name as returned by the model.
   * @param input - Parsed tool input as a plain object.
   * @returns Promise resolving to the string result from the handler.
   * @throws Error if no handler is registered for `name`.
   */
  async dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    const handler = this._handlers.get(name);
    if (handler === undefined) {
      throw new Error(`Unknown tool: ${JSON.stringify(name)}`);
    }
    return handler(input);
  }
}
