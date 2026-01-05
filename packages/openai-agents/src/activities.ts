import { ModelProvider, ModelRequest, ModelResponse } from '@openai/agents';

export interface InvokeModelArgs {
  modelId: string;
  request: ModelRequest;
}

export interface InvokeModelResult {
  response: ModelResponse;
}

/**
 * Creates Temporal activities for AI model invocation using the provided AI SDK provider.
 * These activities allow workflows to call AI models while maintaining Temporal's
 * execution guarantees and replay safety.
 *
 * @param provider The OpenAI Agents provider to use for model invocations
 * @returns An object containing the activity functions
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export function createActivities(provider: ModelProvider): object {
  const activities = {
    async invokeModel(args: InvokeModelArgs): Promise<InvokeModelResult> {
      const model = await provider.getModel(args.modelId);
      return { response: await model.getResponse(args.request) };
    },
  };
  // if (mcpClientFactories !== undefined) {
  //   Object.entries(mcpClientFactories).forEach(([name, func]) => {
  //     activities = {
  //       ...activities,
  //       ...activitiesForName(name, func),
  //     };
  //   });
  // }
  return activities;
}
