import type { McpClient} from '@strands-agents/sdk';
import { BedrockModel, type Model } from '@strands-agents/sdk';
import type { BundleOptions } from '@temporalio/worker';
import { SimplePlugin } from '@temporalio/plugin';
import { ModelActivity } from './model-activity';
import {
  buildCallToolActivity,
  buildListToolsActivity,
  populateMcpCache,
  _clearCache,
} from './temporal-mcp-client';

/**
 * Options for {@link StrandsPlugin}.
 *
 * - `models` — name → factory map. Each factory is called lazily on first
 *   use and the constructed model is cached for the worker's lifetime.
 *   `TemporalAgent({ model: 'name', ... })` selects which factory to invoke.
 *   If omitted, the plugin registers a single `BedrockModel` factory under
 *   the name `'bedrock'` to match Strands' own implicit default.
 *
 * - `mcpClients` — name → MCP client factory map. The plugin connects to
 *   each server once at worker startup to enumerate tools; workflow-side
 *   `TemporalMCPClient({ server: 'name' })` reads from that cache. The
 *   schema is frozen for the worker's lifetime; restart workers to pick up
 *   MCP-server changes.
 */
export interface StrandsPluginOptions {
  models?: Record<string, () => Model>;
  mcpClients?: Record<string, () => McpClient>;
}

/**
 * Temporal plugin that runs Strands Agents inside Temporal workflows. Model,
 * MCP tool, and (via {@link workflow.activityAsTool}) custom-tool invocations
 * are routed through Temporal Activities for durable execution, retries, and
 * timeouts.
 *
 * Register on the worker (and on the client when using `activityAsTool` with
 * interrupts, so the client-side data converter picks up the failure
 * converter):
 *
 * ```ts
 * const client = await Client.connect({ plugins: [new StrandsPlugin({...})] });
 * const worker = new Worker({ ..., plugins: [new StrandsPlugin({...})] });
 * ```
 */
export class StrandsPlugin extends SimplePlugin {
  constructor(options: StrandsPluginOptions = {}) {
    let modelFactories = options.models;
    let defaultName: string | undefined;
    if (modelFactories === undefined) {
      modelFactories = { bedrock: () => new BedrockModel({}) };
      defaultName = 'bedrock';
    }

    const modelActivity = new ModelActivity(modelFactories, defaultName);
    const activities: Record<string, (...args: never[]) => unknown> = {
      invokeModel: (input: never) => modelActivity.invokeModel(input),
      invokeModelStreaming: (input: never) => modelActivity.invokeModelStreaming(input),
    };

    const mcpClients = options.mcpClients ?? {};
    for (const [server, factory] of Object.entries(mcpClients)) {
      const list = buildListToolsActivity(server);
      const call = buildCallToolActivity(server, factory);
      activities[`${server}-listTools`] = list as (...args: never[]) => unknown;
      activities[`${server}-callTool`] = call as (...args: never[]) => unknown;
    }

    const runContext = async (next: () => Promise<void>): Promise<void> => {
      for (const [server, factory] of Object.entries(mcpClients)) {
        await populateMcpCache(server, factory);
      }
      try {
        await next();
      } finally {
        for (const server of Object.keys(mcpClients)) {
          _clearCache(server);
        }
      }
    };

    super({
      name: 'StrandsPlugin',
      activities,
      runContext,
      dataConverter: {
        failureConverterPath: require.resolve('./failure-converter'),
      },
    });
  }

  /**
   * Extend the bundler config so workflow code can bundle `@strands-agents/sdk`:
   *
   * - Ignore `fs` (statically imported by the SDK's `vended-plugins` and
   *   `vended-tools` modules, which are reachable from the index but
   *   unreachable from workflow code).
   *
   * - Replace the dynamic-imported MCP transport helpers
   *   (`@modelcontextprotocol/sdk/client/stdio.js`/`sse.js` and their `node:*`
   *   dependencies) with an empty module. They live in `mcp-config.js`'s
   *   server-only code paths.
   *
   * - Inline async chunks so the bundle stays a single file — webpack's
   *   default JSONP chunk loader references `self`/`document`, neither of
   *   which exists in the workflow VM.
   */
  override configureBundler(options: BundleOptions): BundleOptions {
    const base = super.configureBundler(options);
    const prevHook = base.webpackConfigHook;
    const ignoreModules = [...(base.ignoreModules ?? []), 'fs'];
    return {
      ...base,
      ignoreModules,
      webpackConfigHook: (config) => {
        (config.output ??= {}).asyncChunks = false;
        (config.optimization ??= {}).splitChunks = false;

        // Reach webpack via the constructor of an existing plugin instance —
        // the strands plugin doesn't list webpack as a direct dependency.
        const existing = (config.plugins ?? [])[0] as
          | { constructor: new (regex: RegExp, replacement: (data: { request: string }) => void) => unknown }
          | undefined;
        if (existing) {
          const NormalModuleReplacementPlugin = existing.constructor;
          const empty = require.resolve('./empty-module');
          const ignorePattern =
            /^(?:node:(?:fs\/promises|os|path|process|stream)|@modelcontextprotocol\/sdk\/client\/(?:stdio|sse)\.js)$/;
          // Cast through `unknown` because the strands plugin doesn't list
          // webpack as a dependency and therefore lacks its types.
          config.plugins = (config.plugins ?? []).concat(
            new NormalModuleReplacementPlugin(ignorePattern, (data: { request: string }) => {
              data.request = empty;
            }) as unknown as never
          );
        }

        return prevHook ? prevHook(config) : config;
      },
    };
  }
}
