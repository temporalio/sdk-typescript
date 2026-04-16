/**
 * ToolRegistryPlugin — Temporal plugin for LLM tool-calling activities.
 *
 * Configures the worker's workflow bundle to pass through `anthropic` and
 * `openai` imports, which are otherwise bundled out of the Temporal workflow
 * sandbox. Apply this plugin when using {@link runToolLoop} or
 * {@link AgenticSession} in activities on the same worker as sandboxed
 * workflows.
 *
 * @example
 * ```typescript
 * import { Worker } from '@temporalio/worker';
 * import { ToolRegistryPlugin } from '@temporalio/tool-registry';
 *
 * const worker = await Worker.create({
 *   connection,
 *   namespace: 'default',
 *   taskQueue: 'my-queue',
 *   plugins: [new ToolRegistryPlugin({ provider: 'anthropic' })],
 *   workflowsPath: require.resolve('./workflows'),
 *   activities,
 * });
 * ```
 */

import { SimplePlugin } from '@temporalio/plugin';

/** Options for {@link ToolRegistryPlugin}. */
export interface ToolRegistryPluginOptions {
  /**
   * LLM provider to configure sandbox passthrough for.
   * - `"anthropic"`: pass through `@anthropic-ai/sdk`
   * - `"openai"`: pass through `openai`
   * - `"both"`: pass through both
   * @defaultValue `"anthropic"`
   */
  provider?: 'anthropic' | 'openai' | 'both';

  /**
   * Default Anthropic model name surfaced to activities.
   * @defaultValue `"claude-sonnet-4-6"`
   */
  anthropicModel?: string;

  /**
   * Default OpenAI model name surfaced to activities.
   * @defaultValue `"gpt-4o"`
   */
  openaiModel?: string;
}

/**
 * Temporal plugin that configures sandbox passthrough for LLM imports.
 *
 * The Temporal workflow bundler excludes third-party packages like
 * `@anthropic-ai/sdk` and `openai` from the workflow sandbox. This plugin
 * adds the necessary `ignoreModules` entries so that activities using those
 * libraries can be registered on the same worker as bundled workflows.
 */
export class ToolRegistryPlugin extends SimplePlugin {
  constructor(options: ToolRegistryPluginOptions = {}) {
    const { provider = 'anthropic' } = options;

    const ignoreModules: string[] = [];
    if (provider === 'anthropic' || provider === 'both') {
      ignoreModules.push('@anthropic-ai/sdk');
    }
    if (provider === 'openai' || provider === 'both') {
      ignoreModules.push('openai');
    }

    super({
      name: 'ToolRegistryPlugin',
      ...(ignoreModules.length > 0
        ? {
            bundlerOptions: { ignoreModules },
          }
        : {}),
    });
  }
}
