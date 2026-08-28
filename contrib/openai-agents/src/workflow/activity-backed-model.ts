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
  type ActivityOptions,
  type LocalActivityOptions,
} from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';
import {
  STREAMING_TOPIC_NOT_CONFIGURED,
  type ModelActivityOptions,
  type ModelSummaryProvider,
} from '../common/model-activity-options';
import {
  fromSerializedStreamEvent,
  type InvokeModelActivityInput,
  type InvokeModelStreamActivityInput,
  type JsonValue,
  type SerializedModelRequest,
  type SerializedModelResponse,
  type SerializedStreamEvent,
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
  invokeModelStreamActivity(input: InvokeModelStreamActivityInput): Promise<SerializedStreamEvent[]>;
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
        retry: modelParams.retry,
        cancellationType: modelParams.cancellationType,
        summary: typeof modelParams.summary === 'string' ? modelParams.summary : undefined,
      };
      this.activities = proxyLocalActivities<ModelActivities>(localOpts);
    } else {
      const { useLocalActivity: _useLocalActivity, summary, ...rest } = modelParams;
      const opts: ActivityOptions = {
        ...rest,
        startToCloseTimeout: modelParams.startToCloseTimeout ?? '60s',
        summary: typeof summary === 'string' ? summary : undefined,
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

      const modelSummary = this.modelParams.summary;
      if (modelSummary && typeof modelSummary !== 'string') {
        const provider = modelSummary as ModelSummaryProvider;
        const systemInstructions = request.systemInstructions;
        const summary = provider.provide(this.agent, systemInstructions, request.input);
        const wireResponse = await this.activities.invokeModelActivity.executeWithOptions({ summary }, [input]);
        return fromSerializedModelResponse(wireResponse);
      }

      return fromSerializedModelResponse(await this.activities.invokeModelActivity(input));
    });
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const streamingTopic = this.modelParams.streamingTopic;
    if (streamingTopic === undefined) {
      throw ApplicationFailure.create({
        message: STREAMING_TOPIC_NOT_CONFIGURED.message,
        type: STREAMING_TOPIC_NOT_CONFIGURED.type,
        nonRetryable: true,
      });
    }

    const input: InvokeModelStreamActivityInput = {
      modelName: this.modelName,
      request: toSerializedModelRequest(request),
      streamingTopic,
      ...(this.modelParams.streamingBatchInterval !== undefined && {
        streamingBatchInterval:
          typeof this.modelParams.streamingBatchInterval === 'number'
            ? `${this.modelParams.streamingBatchInterval}ms`
            : this.modelParams.streamingBatchInterval,
      }),
    };

    const events = await withGenerationSpan(async (span) => {
      span.spanData.model = this.modelName;

      const modelSummary = this.modelParams.summary;
      if (modelSummary && typeof modelSummary !== 'string') {
        const provider = modelSummary as ModelSummaryProvider;
        const summary = provider.provide(this.agent, request.systemInstructions, request.input);
        return this.activities.invokeModelStreamActivity.executeWithOptions({ summary }, [input]);
      }

      return this.activities.invokeModelStreamActivity(input);
    });

    // The Activity collects and returns the full event list; yielding from that
    // return value (rather than polling the live stream) keeps replay deterministic.
    for (const event of events) {
      yield fromSerializedStreamEvent(event);
    }
  }
}
