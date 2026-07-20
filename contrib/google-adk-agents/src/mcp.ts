/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Workflow-side MCP boundary for the Google ADK Temporal plugin.
 *
 * MCP is ADK's primary external-tool protocol. `TemporalMCPToolset` is a
 * drop-in `BaseToolset` (from `@google/adk`) that, inside a Workflow, routes
 * tool discovery to a `<name>-listTools` Activity and each tool call to a
 * `<name>-callTool` Activity. The full `FunctionDeclaration` (name +
 * description + parameter schema) round-trips, so the model still receives
 * argument schemas. MCP connection params live only on the worker (plugin
 * options); workflow inputs carry only the toolset *name*.
 *
 * ADK MCP is session-per-call (`MCPSessionManager` opens and closes a fresh
 * client per `getTools` / `runAsync`), so the stateless list-tools + call-tool
 * model below is complete, not a simplification.
 *
 * IMPORTANT: this module is part of the Workflow-sandbox import graph (the
 * public barrel re-exports it and user Workflows import `TemporalMCPToolset`).
 * It must therefore NOT import any worker-only module (`@temporalio/activity`,
 * `@temporalio/workflow-streams`). The Activity *implementations* that open
 * real MCP sessions live in `./activities.ts`, which only `plugin.ts` imports.
 */

import type { FunctionDeclaration } from '@google/genai';
import {
  BaseTool,
  BaseToolset,
  MCPToolset,
  type MCPConnectionParams,
  type ReadonlyContext,
  type RunAsyncToolRequest,
} from '@google/adk';
import type { ActivityOptions } from '@temporalio/common';
import { ApplicationFailure } from '@temporalio/common';
import { inWorkflowContext, proxyActivities } from '@temporalio/workflow';

import { activityOptionsFrom } from './model';

/**
 * A worker-side factory that produces a real MCP toolset (or connection
 * params) for a registered server name. Connection details (process command,
 * URL, headers) stay on the worker and never enter workflow inputs.
 *
 * Returning a {@link BaseToolset} lets callers supply a fully-built toolset
 * (including in-memory test doubles); returning {@link MCPConnectionParams}
 * lets the plugin construct an `MCPToolset` for you.
 */
export type MCPToolsetFactory = () => BaseToolset | MCPConnectionParams;

export interface TemporalMCPToolsetOptions {
  /**
   * Name selecting the worker-registered factory in
   * `GoogleAdkPluginOptions.mcpToolsets`. Also names the pair of Activities
   * (`<name>-listTools`, `<name>-callTool`).
   */
  name: string;
  /** Restrict the advertised tools to these (post-prefix) names. */
  toolFilter?: string[];
  /** Prefix applied to advertised tool names (mirrors ADK `MCPToolset`). */
  prefix?: string;
  /** Per-call Activity configuration (timeouts, retry, task queue). */
  activity?: ActivityOptions;
  /**
   * Connection params used only when `getTools()` runs **outside** a Workflow
   * (direct ADK use / tests), to construct a real `MCPToolset`.
   */
  connectionParams?: MCPConnectionParams;
}

/** @internal */
export interface MCPCallToolArgs {
  /** The underlying (un-prefixed) tool name on the MCP server. */
  toolName: string;
  /** JSON arguments for the tool call. */
  args: Record<string, unknown>;
}

/** The dynamic Activity surface proxied for a named MCP server. */
type MCPActivities = Record<string, (args: Record<string, unknown> | MCPCallToolArgs) => Promise<unknown>>;

/**
 * A {@link BaseToolset} whose MCP traffic is durable under Temporal.
 */
export class TemporalMCPToolset extends BaseToolset {
  private readonly options: TemporalMCPToolsetOptions;

  /**
   * @param options Toolset configuration. `name` selects the worker-side
   *                factory and names the backing Activities.
   */
  constructor(options: TemporalMCPToolsetOptions) {
    super(options.toolFilter ?? [], options.prefix);
    this.options = options;
  }

  /**
   * Discovers the server's tools. Inside a Workflow this proxies the
   * `<name>-listTools` Activity and wraps each returned declaration in a
   * workflow-side {@link TemporalMCPTool}; outside a Workflow it delegates to a
   * real `MCPToolset` built from `connectionParams`.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (!inWorkflowContext()) {
      if (!this.options.connectionParams) {
        throw ApplicationFailure.nonRetryable(
          `TemporalMCPToolset('${this.options.name}').getTools() was called outside a ` +
            'Workflow without `connectionParams`. Provide connectionParams to use this ' +
            'toolset directly with ADK (non-Temporal).',
          'GoogleAdkMCPToolsetOutsideWorkflow'
        );
      }
      const real = new MCPToolset(this.options.connectionParams, this.options.toolFilter ?? [], this.options.prefix);
      return real.getTools(context);
    }

    const activities = proxyActivities<MCPActivities>(
      activityOptionsFrom(this.options.activity, `adk.mcp ${this.options.name}.listTools`)
    );
    const listTools = activities[`${this.options.name}-listTools`] as (
      args: Record<string, unknown>
    ) => Promise<FunctionDeclaration[]>;
    const declarations = await listTools({});

    const tools = declarations.map((declaration) => new TemporalMCPTool(declaration, this.options));

    const filter = this.options.toolFilter;
    if (!filter || filter.length === 0) {
      return tools;
    }
    // Filter is matched against the (possibly-prefixed) advertised name,
    // mirroring ADK `MCPToolset` semantics.
    return tools.filter((tool) => filter.includes(tool.name));
  }

  /**
   * No-op: MCP sessions are opened and closed per Activity invocation on the
   * worker (ADK MCP is session-per-call), so there is nothing to close on the
   * workflow side.
   */
  override async close(): Promise<void> {}
}

/**
 * Workflow-side handle for a single MCP tool. Carries the server's full
 * `FunctionDeclaration` (so the model sees the argument schema) and routes
 * `runAsync` to the `<name>-callTool` Activity, stripping any advertised
 * prefix to recover the original server-side tool name.
 */
class TemporalMCPTool extends BaseTool {
  private readonly declaration: FunctionDeclaration;
  private readonly originalName: string;
  private readonly toolsetOptions: TemporalMCPToolsetOptions;

  /**
   * @param declaration     The full declaration returned by `<name>-listTools`.
   * @param toolsetOptions  The owning toolset's options (name, prefix, activity).
   */
  constructor(declaration: FunctionDeclaration, toolsetOptions: TemporalMCPToolsetOptions) {
    const originalName = declaration.name ?? '';
    const advertisedName = toolsetOptions.prefix ? `${toolsetOptions.prefix}_${originalName}` : originalName;
    super({ name: advertisedName, description: declaration.description ?? '' });
    this.declaration = declaration;
    this.originalName = originalName;
    this.toolsetOptions = toolsetOptions;
  }

  /** Returns the full declaration (schema preserved) with the advertised name. */
  override _getDeclaration(): FunctionDeclaration {
    return { ...this.declaration, name: this.name };
  }

  /** Routes the tool call to the `<name>-callTool` Activity. */
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const activities = proxyActivities<MCPActivities>(
      activityOptionsFrom(this.toolsetOptions.activity, `adk.mcp ${this.toolsetOptions.name}.${this.originalName}`)
    );
    const callTool = activities[`${this.toolsetOptions.name}-callTool`] as (args: MCPCallToolArgs) => Promise<unknown>;
    return callTool({ toolName: this.originalName, args: request.args });
  }
}
