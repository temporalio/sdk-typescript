import type { McpClient} from '@strands-agents/sdk';
import { BedrockModel, type Model } from '@strands-agents/sdk';
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
}
