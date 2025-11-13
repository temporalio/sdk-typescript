import { ProviderV2 } from '@ai-sdk/provider';
import { SimplePlugin } from '@temporalio/plugin';
import { createActivities } from './activities';

/**
 * A Temporal plugin that integrates AI SDK providers for use in workflows.
 * This plugin creates activities that allow workflows to invoke AI models.
 *
 * @experimental The AI SDK plugin is an experimental feature; APIs may change without notice.
 */
export class AiSDKPlugin extends SimplePlugin {
  constructor(modelProvider: ProviderV2) {
    super({
      name: 'AiSDKPlugin',
      activities: createActivities(modelProvider),
    });
  }
}
