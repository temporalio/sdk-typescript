import { ProviderV2 } from '@ai-sdk/provider';
import { SimplePlugin } from '@temporalio/plugin';
import { createActivities } from './activities';

export class AiSDKPlugin extends SimplePlugin {
  constructor(modelProvider: ProviderV2) {
    super({
      name: 'AiSDKPlugin',
      activities: createActivities(modelProvider),
    });
  }
}