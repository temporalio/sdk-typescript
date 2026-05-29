import {
  Usage,
  withGenerationSpan,
  type Agent,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type UsageInput,
} from '@openai/agents-core';
import {
  proxyActivities,
  proxyLocalActivities,
  type ActivityInterfaceFor,
  type LocalActivityInterfaceFor,
} from '@temporalio/workflow';
import type { ActivityOptions, LocalActivityOptions } from '@temporalio/common';
import type { ModelActivityOptions, ModelSummaryProvider } from '../common/model-activity-options';
import {
  type InvokeModelActivityInput,
  type JsonValue,
  type SerializedModelRequest,
  type SerializedModelResponse,
} from '../common/serialized-model';

export function toSerializedModelRequest(request: ModelRequest): SerializedModelRequest {
  return {
    systemInstructions: request.systemInstructions,
    input: request.input as JsonValue,
    modelSettings: request.modelSettings,
    tools: request.tools,
    toolsExplicitlyProvided: request.toolsExplicitlyProvided,
    outputType: request.outputType,
    handoffs: request.handoffs,
    prompt: request.prompt as JsonValue | undefined,
    previousResponseId: request.previousResponseId,
    conversationId: request.conversationId,
    tracing: request.tracing as JsonValue,
    overridePromptModel: request.overridePromptModel,
  };
}

function fromSerializedModelResponse(wire: SerializedModelResponse): ModelResponse {
  return {
    usage: Usage.fromJSON(wire.usage as UsageInput),
    output: wire.output as unknown as AgentOutputItem[],
    responseId: wire.responseId,
    providerData: wire.providerData,
  };
}

interface ModelActivities {
  invokeModelActivity(input: InvokeModelActivityInput): Promise<SerializedModelResponse>;
}

/**
 * Model implementation that delegates each call to a Temporal Activity, so all
 * LLM calls execute on the Activity Worker (where real ModelProviders live).
 */
export class ActivityBackedModel implements Model {
  private readonly activities: ActivityInterfaceFor<ModelActivities> | LocalActivityInterfaceFor<ModelActivities>;
  private readonly modelParams: ModelActivityOptions;
  private agent?: Agent<any, any>;

  constructor(
    private readonly modelName: string,
    modelParams: ModelActivityOptions
  ) {
    this.modelParams = modelParams;

    if (modelParams.useLocalActivity) {
      const localOpts: LocalActivityOptions = {
        startToCloseTimeout: modelParams.startToCloseTimeout ?? '60s',
        scheduleToCloseTimeout: modelParams.scheduleToCloseTimeout,
        retry: modelParams.retryPolicy,
        cancellationType: modelParams.cancellationType,
        summary: typeof modelParams.summaryOverride === 'string' ? modelParams.summaryOverride : undefined,
      };
      this.activities = proxyLocalActivities<ModelActivities>(localOpts);
    } else {
      const opts: ActivityOptions = {
        startToCloseTimeout: modelParams.startToCloseTimeout ?? '60s',
        heartbeatTimeout: modelParams.heartbeatTimeout,
        taskQueue: modelParams.taskQueue,
        scheduleToCloseTimeout: modelParams.scheduleToCloseTimeout,
        scheduleToStartTimeout: modelParams.scheduleToStartTimeout,
        retry: modelParams.retryPolicy,
        cancellationType: modelParams.cancellationType,
        summary: typeof modelParams.summaryOverride === 'string' ? modelParams.summaryOverride : undefined,
        priority: modelParams.priority,
      };
      this.activities = proxyActivities<ModelActivities>(opts);
    }
  }

  setAgent(agent: Agent<any, any>): void {
    this.agent = agent;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    // Wrap in a generation span so the trace tree has agent → generation → Activity.
    return withGenerationSpan(async (span) => {
      span.spanData.model = this.modelName;

      const wire = toSerializedModelRequest(request);
      const input: InvokeModelActivityInput = {
        modelName: this.modelName,
        request: wire,
      };

      const summaryOverride = this.modelParams.summaryOverride;
      if (summaryOverride && typeof summaryOverride !== 'string') {
        const provider = summaryOverride as ModelSummaryProvider;
        const systemInstructions = request.systemInstructions;
        const summary = provider.provide(this.agent, systemInstructions, request.input);
        const wireResponse = await this.activities.invokeModelActivity.executeWithOptions({ summary }, [input]);
        return fromSerializedModelResponse(wireResponse);
      }

      return fromSerializedModelResponse(await this.activities.invokeModelActivity(input));
    });
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error(
      'Streaming is not supported in Temporal workflows. ' + 'Use non-streaming mode with TemporalOpenAIRunner.'
    );
  }
}
