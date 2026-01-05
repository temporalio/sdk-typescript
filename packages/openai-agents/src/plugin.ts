import { ModelProvider } from '@openai/agents';
import { SimplePlugin } from '@temporalio/plugin';
import { createActivities } from './activities';

/**
 * Options for the AI SDK plugin
 *
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export interface OpenAIAgentsPluginOptions {
  modelProvider: ModelProvider;
}

/**
 * A Temporal plugin that integrates OpenAI Agents SDK providers for use in workflows.
 * This plugin creates activities that allow workflows to invoke AI models.
 *
 * @experimental The OpenAI Agents SDK plugin is an experimental feature; APIs may change without notice.
 */
export class OpenAIAgentsPlugin extends SimplePlugin {
  constructor(options: OpenAIAgentsPluginOptions) {
    super({
      name: 'OpenAIAgentsPlugin',
      activities: createActivities(options.modelProvider)
    });
  }
}
