/**
 * @experimental The OpenAI Agents plugin is an experimental feature; APIs may change without notice.
 */

import { trace } from '@opentelemetry/api';
import type { ModelProvider } from '@openai/agents-core';
import { SimplePlugin } from '@temporalio/plugin';
import type { BundleOptions, InjectedSinks, ReplayWorkerOptions, WorkerOptions } from '@temporalio/worker';
import { OpenAIAgentsTraceClientInterceptor } from '../client/trace-interceptor';
import { AGENT_TRACING_SINK_NAME, type AgentTracingSinks } from '../common/agent-sink-types';
import type { SerializableModelActivityOptions } from '../common/model-activity-options';
import { isReplaySafeTracerProvider } from '../common/tracing-bridge';
import { createModelActivity } from './activities';
import { ensureActivityTracingProcessorRegistered } from './activity-tracing';
import { makeAgentTracingSink } from './agent-sink-bridge';
import type { StatelessMCPServerProvider } from './mcp-provider';
import type { SandboxClientProvider } from './sandbox-provider';
import type { StatefulMCPServerProvider } from './stateful-mcp-provider';
import {
  OpenAIAgentsTraceActivityInboundInterceptor,
  OpenAIAgentsTraceNexusInboundInterceptor,
  type OpenAIAgentsTraceInterceptorOptions,
} from './trace-interceptor';

export type MCPServerProvider = StatelessMCPServerProvider | StatefulMCPServerProvider;

/**
 * Options controlling trace interceptor behavior on both the Activity side
 * (directly) and the Workflow side (via header propagation).
 */
export interface OpenAIAgentsPluginInterceptorOptions {
  /** Wrap calls in `temporal:*` custom spans. @default false */
  addTemporalSpans?: boolean;
  /**
   * Emit OTel spans for agent-SDK trace/span events. Orthogonal to
   * `addTemporalSpans`. @default false
   */
  useOtelInstrumentation?: boolean;
}

export interface OpenAIAgentsPluginOptions {
  /** Model provider used to resolve model names to Model instances. */
  modelProvider: ModelProvider;
  /** MCP server providers whose Activities will be auto-registered. */
  mcpServerProviders?: MCPServerProvider[];
  /**
   * Sandbox client providers whose Activities will be auto-registered.
   * Reference them from Workflows via `temporalSandboxClient(name)`.
   *
   * @experimental Sandbox support is experimental and may change without notice.
   */
  sandboxClients?: SandboxClientProvider[];
  /**
   * Default Model Activity options (timeouts, retry, Task Queue, etc.).
   * Propagated to the Workflow via the `__openai_agents_config` header.
   */
  modelParams?: SerializableModelActivityOptions;
  /**
   * Trace interceptor options. Propagated to the Workflow via the
   * `__openai_agents_config` header and applied to Activities directly.
   */
  interceptorOptions?: OpenAIAgentsPluginInterceptorOptions;
}

/**
 * Temporal plugin integrating the OpenAI Agents SDK. Registers model
 * invocation Activities so Workflow-side ActivityBackedModel can delegate LLM
 * calls, and wires trace propagation between client/Workflow/Activity.
 *
 * @experimental The OpenAI Agents plugin is an experimental feature; APIs may change without notice.
 */
export class OpenAIAgentsPlugin extends SimplePlugin {
  constructor(options: OpenAIAgentsPluginOptions) {
    const modelActivities = createModelActivity(options.modelProvider);

    let allActivities: Record<string, (...args: any[]) => Promise<any>> = { ...modelActivities };

    const providers: Array<{ name: string; _getActivities(): Record<string, (...args: any[]) => Promise<any>> }> = [
      ...(options.mcpServerProviders ?? []),
      ...(options.sandboxClients ?? []),
    ];
    const seenNames = new Set<string>();
    for (const provider of providers) {
      if (seenNames.has(provider.name)) {
        throw new Error(
          `Duplicate provider name: '${provider.name}'. Each MCP server and sandbox client provider must have a unique name.`
        );
      }
      seenNames.add(provider.name);
      allActivities = { ...allActivities, ...provider._getActivities() };
    }

    const interceptorOpts = options.interceptorOptions;
    const activityInterceptorOptions: OpenAIAgentsTraceInterceptorOptions = {
      addTemporalSpans: interceptorOpts?.addTemporalSpans,
    };

    if (interceptorOpts?.useOtelInstrumentation) {
      // OTel's `setGlobalTracerProvider` wraps the caller's provider in a ProxyTracerProvider;
      // unwrap to read the brand off the actual delegate.
      const globalProvider = trace.getTracerProvider();
      const actualProvider = (globalProvider as { getDelegate?: () => unknown }).getDelegate?.() ?? globalProvider;
      if (!isReplaySafeTracerProvider(actualProvider)) {
        throw new Error(
          'Global TracerProvider must be created via createTracerProvider from @temporalio/openai-agents/otel. ' +
            'Call setGlobalTracerProvider(createTracerProvider({...})) before constructing OpenAIAgentsPlugin.'
        );
      }
    }

    ensureActivityTracingProcessorRegistered();

    super({
      name: 'OpenAIAgentsPlugin',
      activities: allActivities,
      clientInterceptors: {
        workflow: [
          new OpenAIAgentsTraceClientInterceptor({
            addTemporalSpans: interceptorOpts?.addTemporalSpans,
            useOtelInstrumentation: interceptorOpts?.useOtelInstrumentation,
            modelParams: options.modelParams,
          }),
        ],
      },
      workerInterceptors: {
        workflowModules: [require.resolve('../workflow/trace-interceptor')],
        activity: [
          (ctx) => ({ inbound: new OpenAIAgentsTraceActivityInboundInterceptor(ctx, activityInterceptorOptions) }),
        ],
        nexus: [() => ({ inbound: new OpenAIAgentsTraceNexusInboundInterceptor() })],
      },
    });
  }

  override configureWorker(options: WorkerOptions): WorkerOptions {
    return super.configureWorker(this.injectSinks(options));
  }

  override configureReplayWorker(options: ReplayWorkerOptions): ReplayWorkerOptions {
    return super.configureReplayWorker(this.injectSinks(options));
  }

  override configureBundler(options: BundleOptions): BundleOptions {
    // Prepend a polyfill-installer module to the webpack `entry` array so it
    // evaluates before any other module in the Workflow bundle. Webpack 5
    // emits multi-entry scripts that execute in array order at script-load,
    // so this guarantees `globalThis.ReadableStream` (and the other Web-API
    // shims) are populated before agents-core's browser shim captures them
    // into module-level constants.
    const polyfillPath = require.resolve('../workflow/preload-polyfills');
    const baseOptions = super.configureBundler(options);
    const existingHook = baseOptions.webpackConfigHook;
    return {
      ...baseOptions,
      webpackConfigHook: (config) => {
        const cfg = existingHook ? existingHook(config) : config;
        const existingEntry = cfg.entry;
        const entries = Array.isArray(existingEntry)
          ? existingEntry
          : existingEntry !== undefined
            ? [existingEntry as string]
            : [];
        return { ...cfg, entry: [polyfillPath, ...entries] };
      },
    };
  }

  private injectSinks<T extends { sinks?: InjectedSinks<any> }>(options: T): T {
    // Registered unconditionally; per-Workflow useOtelInstrumentation flag drives suppression
    // at the bridge layer via the SUPPRESS_OTEL_BRIDGE marker.
    const sinks: InjectedSinks<AgentTracingSinks> = {
      [AGENT_TRACING_SINK_NAME]: makeAgentTracingSink(),
    };
    return {
      ...options,
      sinks: {
        ...options.sinks,
        ...sinks,
      },
    };
  }
}
