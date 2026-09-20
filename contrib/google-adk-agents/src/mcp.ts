/**
 * Workflow-side MCP boundary for the Google ADK Temporal plugin.
 *
 * MCP is ADK's primary external-tool protocol. `TemporalMCPToolset` is a
 * drop-in `BaseToolset` (from `@google/adk`) that, inside a Workflow, routes
 * tool discovery to a `<name>-listTools` Activity and each tool call to a
 * `<name>-callTool` Activity. The full `FunctionDeclaration` (name +
 * description + parameter schema) round-trips, so the model still receives
 * argument schemas. The live MCP session is opened worker-side; call inputs
 * carry the tool name and the model's arguments.
 *
 * IMPORTANT: this module is part of the Workflow-sandbox import graph (the
 * `./workflow` entry point re-exports it and user Workflows import
 * `TemporalMCPToolset`). It must therefore NOT import any worker-only module
 * (`@temporalio/activity`, `@temporalio/workflow-streams/client`). The Activity
 * *implementations* that open real MCP sessions live in `./activities.ts`,
 * which nothing in that graph imports.
 *
 * ADK's own MCP classes are not on the `@google/adk` surface the Workflow
 * bundle pins (ADK 2.0's web build; MCP lives on the full barrel and the
 * `@google/adk/tools/mcp` subpath), while the barrel's single typings file
 * still declares them. Everything this module needs from them runs OUTSIDE a
 * Workflow — the direct (non-Temporal) fallback — so the class is looked up
 * lazily there instead of value-imported, which would compile and be
 * `undefined` in the sandbox.
 */

import type { FunctionDeclaration } from '@google/genai';
import * as adk from '@google/adk';
import {
  BaseTool,
  BaseToolset,
  type Context,
  type MCPConnectionParams,
  type ReadonlyContext,
  type RunAsyncToolRequest,
} from '@google/adk';
import { ApplicationFailure } from '@temporalio/common';
import { type ActivityOptions, inWorkflowContext, proxyActivities } from '@temporalio/workflow';

import { gateOnConfirmation } from './confirmation';
import { MCP_TOOLSET_OUTSIDE_WORKFLOW_FAILURE_TYPE } from './error-types';
import { activityOptionsFrom } from './model';

/**
 * A worker-side factory that produces a real MCP toolset (or connection
 * params) for a registered server name. Connection details (process command,
 * URL, headers) stay on the worker and never enter workflow inputs.
 *
 * Returning a {@link BaseToolset} lets callers supply a fully-built toolset
 * (including in-memory test doubles), at the cost of a real MCP toolset opening two
 * sessions per tool call — against a stdio server, two subprocesses. Returning
 * {@link MCPConnectionParams} lets the plugin open one session per call instead.
 *
 * The plugin calls the factory on every Activity invocation, and closes only what it
 * builds itself from {@link MCPConnectionParams}. A toolset holding a resource should
 * therefore be a single long-lived instance the factory returns each time, and closing
 * it stays the factory author's job. Supplying {@link MCPConnectionParams} instead
 * hands that lifecycle to the plugin.
 */
export type MCPToolsetFactory = () => BaseToolset | MCPConnectionParams;

/**
 * Whether an MCP tool call needs human approval before it runs: a flag for
 * every tool of the toolset, or a predicate over the model's arguments and the
 * tool name as advertised to the model, which carries the toolset's `prefix`
 * when it sets one. A predicate MUST be a pure function of its inputs — ADK
 * re-evaluates it when binding the human's approval to the pinned call and
 * refuses the approval if it then answers `false`.
 */
export type MCPRequireConfirmation =
  | boolean
  | ((toolName: string, args: Record<string, unknown>, toolContext?: Context) => boolean | Promise<boolean>);

/** Resolves an {@link MCPRequireConfirmation} for one call. @internal */
function evaluateMCPRequireConfirmation(
  gate: MCPRequireConfirmation | undefined,
  toolName: string,
  args: Record<string, unknown>,
  toolContext?: Context
): boolean | Promise<boolean> {
  if (gate === undefined || gate === false) return false;
  if (gate === true) return true;
  return gate(toolName, args, toolContext);
}

export interface TemporalMCPToolsetOptions {
  /**
   * Name selecting the worker-registered factory in
   * `GoogleAdkPluginOptions.mcpToolsets`. Also names the pair of Activities
   * (`<name>-listTools`, `<name>-callTool`).
   */
  name: string;
  /**
   * Restrict the advertised tools to these (post-prefix) names. ADK's other
   * `toolFilter` form, a `ToolPredicate`, is not supported.
   */
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
  /**
   * Gate the toolset's tools behind human approval, like ADK's
   * `FunctionTool({ requireConfirmation })`. The `<name>-callTool` Activity is
   * NOT scheduled on the pass that raises the confirmation request, nor after a
   * rejection; it runs once the resumed turn carries the approval (see
   * `hitlConfirmationResponse`). Outside a Workflow (the direct `connectionParams`
   * path) the same gate wraps the tools ADK's own `MCPToolset` returns, so nothing
   * reaches the server unapproved there either. Only enforced on an `LlmAgent`
   * turn — ADK 2.0's workflow `ToolNode` does not route through the confirmation
   * path.
   */
  requireConfirmation?: MCPRequireConfirmation;
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

type MCPToolsetCtor = new (
  connectionParams: MCPConnectionParams,
  toolFilter?: string[],
  prefix?: string
) => BaseToolset;

/**
 * Reads a named export off a module namespace without letting the bundler see
 * which one, so a request for an export absent from the runtime surface is a
 * plain `undefined` rather than a build-time diagnostic.
 */
function readExport(namespace: object, exportName: string): unknown {
  return (namespace as Record<string, unknown>)[exportName];
}

/**
 * ADK's real `MCPToolset` constructor, for the direct (non-Workflow) path. On
 * the worker `@google/adk` is the full barrel and the class is present; inside
 * a Workflow this is never reached (MCP traffic goes through Activities) and
 * the class is absent from the pinned web surface — hence the lazy lookup.
 */
function mcpToolsetCtor(name: string): MCPToolsetCtor {
  const ctor = readExport(adk, 'MCPToolset') as MCPToolsetCtor | undefined;
  if (ctor === undefined) {
    throw ApplicationFailure.nonRetryable(
      `TemporalMCPToolset('${name}'): @google/adk's MCPToolset is not available in this runtime. ` +
        "ADK 2.0 ships MCP only on its full (node) barrel; the Workflow bundle pins ADK's web build, " +
        'which omits it. MCP traffic inside a Workflow is routed through the <name>-listTools / ' +
        '<name>-callTool Activities and never needs it.',
      MCP_TOOLSET_OUTSIDE_WORKFLOW_FAILURE_TYPE
    );
  }
  return ctor;
}

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
      const tools = await this.realToolset('getTools').getTools(context);
      // ADK's own `MCPToolset` knows nothing about `requireConfirmation`, so the
      // gate has to be put back on top of the tools it returns; without this the
      // option is silently dropped on the path the README calls supported.
      const gate = this.options.requireConfirmation;
      return gate === undefined ? tools : tools.map((tool) => new GatedMCPTool(tool, gate));
    }

    const listTools = this.activities(`adk.mcp ${this.options.name}.listTools`)[`${this.options.name}-listTools`] as (
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

  /** No-op: the workflow-side toolset holds no MCP session to close. */
  override async close(): Promise<void> {}

  private activities(defaultSummary: string): MCPActivities {
    return proxyActivities<MCPActivities>(activityOptionsFrom(this.options.activity, defaultSummary));
  }

  /** The real ADK toolset for the direct (non-Workflow) path. */
  private realToolset(method: string): BaseToolset {
    if (!this.options.connectionParams) {
      throw ApplicationFailure.nonRetryable(
        `TemporalMCPToolset('${this.options.name}').${method}() was called outside a ` +
          'Workflow without `connectionParams`. Provide connectionParams to use this ' +
          'toolset directly with ADK (non-Temporal).',
        MCP_TOOLSET_OUTSIDE_WORKFLOW_FAILURE_TYPE
      );
    }
    const MCPToolset = mcpToolsetCtor(this.options.name);
    return new MCPToolset(this.options.connectionParams, this.options.toolFilter ?? [], this.options.prefix);
  }
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

  /**
   * Whether a call with `args` needs human approval — the declarative side of
   * the gate, which ADK consults when binding an approval to the pinned call.
   */
  override async checkRequireConfirmation(args: Record<string, unknown>, toolContext?: Context): Promise<boolean> {
    return evaluateMCPRequireConfirmation(this.toolsetOptions.requireConfirmation, this.name, args, toolContext);
  }

  /** Routes the tool call to the `<name>-callTool` Activity. */
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    if (await this.checkRequireConfirmation(request.args, request.toolContext)) {
      const gated = gateOnConfirmation(this.name, request.toolContext);
      if (gated !== undefined) return gated;
    }
    const activities = proxyActivities<MCPActivities>(
      activityOptionsFrom(this.toolsetOptions.activity, `adk.mcp ${this.toolsetOptions.name}.${this.originalName}`)
    );
    const callTool = activities[`${this.toolsetOptions.name}-callTool`] as (args: MCPCallToolArgs) => Promise<unknown>;
    return callTool({ toolName: this.originalName, args: request.args });
  }
}

/**
 * An ADK `MCPTool` with the toolset's confirmation gate in front of it, for the
 * direct (non-Workflow) path. ADK's `MCPToolset` builds its own tools and has no
 * `requireConfirmation` of its own, so the gate is applied by delegation: the
 * declaration and the call both belong to the wrapped tool, and nothing reaches
 * the MCP server until the human approves.
 *
 * The wrapped tool's `name` is already the advertised one (ADK's `MCPToolset`
 * applies `prefix` when it constructs them), so a predicate sees the same name
 * here as it does inside a Workflow.
 */
class GatedMCPTool extends BaseTool {
  constructor(
    private readonly tool: BaseTool,
    private readonly gate: MCPRequireConfirmation
  ) {
    super({ name: tool.name, description: tool.description, isLongRunning: tool.isLongRunning });
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.tool._getDeclaration();
  }

  override async checkRequireConfirmation(args: Record<string, unknown>, toolContext?: Context): Promise<boolean> {
    return evaluateMCPRequireConfirmation(this.gate, this.name, args, toolContext);
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    if (await this.checkRequireConfirmation(request.args, request.toolContext)) {
      const gated = gateOnConfirmation(this.name, request.toolContext);
      if (gated !== undefined) return gated;
    }
    return this.tool.runAsync(request);
  }
}
