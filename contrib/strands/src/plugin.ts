import type { McpClient } from '@strands-agents/sdk';
import { BedrockModel, type Model } from '@strands-agents/sdk';
import type { Duration } from '@temporalio/common';
import { msOptionalToNumber } from '@temporalio/common/lib/time';
import type { BundleOptions } from '@temporalio/worker';
import { SimplePlugin } from '@temporalio/plugin';
import { ModelActivity } from './model-activity';
import type { InvokeModelInput, InvokeModelStreamingInput } from './model-activity';
import {
  buildCallToolActivity,
  buildListToolsActivity,
  callToolActivityName,
  listToolsActivityName,
  _evictConnection,
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
 * - `mcpClients` — name → MCP client factory map. Workflow-side
 *   `TemporalMCPClient({ server: 'name' })` selects a factory by name; the
 *   per-server `{name}-listTools` and `{name}-callTool` activities reuse one
 *   lazily-opened worker-process connection. Tools are enumerated live on each
 *   `listTools`. By default (`TemporalMCPClient`'s `cacheTools: false`) the
 *   agent re-lists on each turn, so it picks up MCP-server changes (including
 *   redeploys) mid-workflow without restarting the worker; set `cacheTools:
 *   true` to list once at the start of the workflow instead.
 *
 * - `mcpConnectionIdleTimeout` — how long a worker-process MCP connection is
 *   kept open between `callTool` activities before it's disconnected. The timer
 *   resets on every reuse. Accepts a millisecond number or a duration string
 *   (e.g. `'5 minutes'`), like `startToCloseTimeout`. Defaults to
 *   {@link MCP_CONNECTION_IDLE_MS} (5 minutes).
 */
export interface StrandsPluginOptions {
  models?: Record<string, () => Model>;
  mcpClients?: Record<string, () => McpClient>;
  mcpConnectionIdleTimeout?: Duration;
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
    } else {
      const names = Object.keys(modelFactories);
      if (names.length === 1) {
        defaultName = names[0];
      }
    }

    const modelActivity = new ModelActivity(modelFactories, defaultName);
    const activities: Record<string, (...args: never[]) => unknown> = {
      invokeModel: (input: InvokeModelInput) => modelActivity.invokeModel(input),
      invokeModelStreaming: (input: InvokeModelStreamingInput) => modelActivity.invokeModelStreaming(input),
    };

    const mcpClients = options.mcpClients ?? {};
    const idleMs = msOptionalToNumber(options.mcpConnectionIdleTimeout);
    for (const [server, factory] of Object.entries(mcpClients)) {
      activities[listToolsActivityName(server)] = buildListToolsActivity(server, factory, idleMs);
      activities[callToolActivityName(server)] = buildCallToolActivity(server, factory, idleMs);
    }

    const runContext = async (next: () => Promise<void>): Promise<void> => {
      try {
        await next();
      } finally {
        // Close any worker-process MCP connections opened lazily by the
        // listTools/callTool activities.
        for (const server of Object.keys(mcpClients)) {
          await _evictConnection(server);
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
   * - Ignore worker-only / non-workflow-safe modules that the SDK index
   *   transitively pulls in but that are unreachable from workflow code.
   *   This covers:
   *   - `fs` (statically imported by `vended-plugins` and `vended-tools`).
   *   - Every `@strands-agents/sdk` model provider's HTTP SDK
   *     (`@aws-sdk/client-bedrock-runtime`, `@anthropic-ai/sdk`, `openai`,
   *     `@google/genai`, `ai`). The workers constructs models worker-side;
   *     workflow code only goes through {@link TemporalModel}.
   *   - `@temporalio/activity` and `@temporalio/client`, which the
   *     worker-only halves of {@link TemporalMCPClient}, {@link autoHeartbeat},
   *     and `@temporalio/workflow-streams/client` import.
   *   - `path` / `crypto`, pulled in transitively by the same worker-only code.
   *
   * - Replace the dynamic-imported MCP transport helpers
   *   (`@modelcontextprotocol/sdk/client/{stdio,sse,streamableHttp}.js` and
   *   their `node:*` dependencies, plus `eventsource-parser/stream` which
   *   `streamableHttp.js` reaches) with an empty module. They live in
   *   `mcp-config.js`'s server-only code paths.
   *
   * - Inline async chunks so the bundle stays a single file — webpack's
   *   default JSONP chunk loader references `self`/`document`, neither of
   *   which exists in the workflow VM.
   */
  override configureBundler(options: BundleOptions): BundleOptions {
    const base = super.configureBundler(options);
    const prevHook = base.webpackConfigHook;
    const ignoreModules = [
      ...(base.ignoreModules ?? []),
      'fs',
      'path',
      'crypto',
      '@temporalio/activity',
      '@temporalio/client',
      '@aws-sdk/client-bedrock-runtime',
      '@aws-sdk/middleware-websocket',
      '@anthropic-ai/sdk',
      'openai',
      '@google/genai',
      'ai',
    ];
    return {
      ...base,
      ignoreModules,
      webpackConfigHook: (config) => {
        (config.output ??= {}).asyncChunks = false;
        (config.optimization ??= {}).splitChunks = false;

        const plugins = [...(config.plugins ?? [])];
        plugins.push(emptyModuleRewritesPlugin() as (typeof plugins)[number]);
        const merged = { ...config, plugins };

        return prevHook ? prevHook(merged) : merged;
      },
    };
  }
}

/**
 * The slice of webpack's runtime API these rewrites use, read off the running
 * compiler (see {@link emptyModuleRewritesPlugin}).
 */
interface WebpackApi {
  NormalModuleReplacementPlugin: new (
    resourceRegExp: RegExp,
    newResource: (resource: { request: string }) => void
  ) => WebpackPlugin;
}

interface WebpackPlugin {
  apply(compiler: WebpackCompiler): void;
}

interface WebpackCompiler {
  /** webpack 5 exposes its own runtime API on the compiler. */
  webpack: WebpackApi;
}

/**
 * A webpack plugin that stubs out `@strands-agents/sdk`'s worker-only static and
 * dynamic imports — `node:*` builtins and the MCP client transports — with an
 * empty module, so they never reach the Workflow isolate. Paired with the
 * `ignoreModules` whitelist (see {@link StrandsPlugin.configureBundler}).
 *
 * webpack is taken from `compiler.webpack` rather than imported or borrowed off
 * another plugin's constructor: `@temporalio/strands-agents` doesn't depend on
 * webpack directly, and using the compiler's own webpack guarantees the exact
 * instance running the bundle regardless of how the SDK orders its own bundler
 * plugins — never a second copy.
 */
function emptyModuleRewritesPlugin(): WebpackPlugin {
  const empty = require.resolve('./empty-module');
  const ignorePattern =
    /^(?:node:(?:fs\/promises|os|path|process|stream)|@modelcontextprotocol\/sdk\/client\/(?:stdio|sse|streamableHttp)\.js|eventsource-parser\/stream)$/;
  return {
    apply(compiler) {
      const { NormalModuleReplacementPlugin } = compiler.webpack;
      new NormalModuleReplacementPlugin(ignorePattern, (resource) => {
        resource.request = empty;
      }).apply(compiler);
    },
  };
}
