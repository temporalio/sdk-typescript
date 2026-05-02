import type { ModelProvider } from '@openai/agents-core';
import { SimplePlugin } from '@temporalio/plugin';
import type { ModelActivityOptions } from '../common/model-activity-options';
import { createModelActivity } from './activities';
import type { StatelessMCPServerProvider } from './mcp-provider';

/**
 * Options for the OpenAI Agents plugin.
 */
export interface OpenAIAgentsPluginOptions {
  /** The model provider to use for resolving model names to Model instances (e.g. OpenAIProvider) */
  modelProvider: ModelProvider;
  /** Stateless MCP server providers whose activities will be auto-registered */
  mcpServerProviders?: StatelessMCPServerProvider[];
  /**
   * Default model activity options (timeouts, retry, task queue, etc.).
   *
   * Config surface only — users must still pass `modelParams` to
   * `new TemporalOpenAIRunner(options)` in workflow code because the plugin
   * runs worker-side and cannot inject config into the V8 workflow sandbox.
   * Future versions may auto-propagate via workflow interceptors.
   */
  modelParams?: ModelActivityOptions;
}

/**
 * A Temporal plugin that integrates the OpenAI Agents SDK for use in workflows.
 * Registers model invocation activities so that workflow-side ActivityBackedModel
 * can delegate LLM calls to the activity worker.
 */
export class OpenAIAgentsPlugin extends SimplePlugin {
  constructor(options: OpenAIAgentsPluginOptions) {
    const modelActivities = createModelActivity(options.modelProvider);

    let allActivities: Record<string, (...args: any[]) => Promise<any>> = { ...modelActivities };

    if (options.mcpServerProviders) {
      const seenNames = new Set<string>();
      for (const provider of options.mcpServerProviders ?? []) {
        if (seenNames.has(provider.name)) {
          throw new Error(
            `Duplicate MCP server provider name: '${provider.name}'. Each provider must have a unique name — activity keys collide.`
          );
        }
        seenNames.add(provider.name);
      }

      for (const provider of options.mcpServerProviders) {
        const providerActivities = provider._getActivities();
        allActivities = { ...allActivities, ...providerActivities };
      }
    }

    super({
      name: 'OpenAIAgentsPlugin',
      activities: allActivities,
    });
  }
}
