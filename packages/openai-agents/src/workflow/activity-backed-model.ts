import {
  Usage,
  type Agent,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents-core';
import { proxyActivities, proxyLocalActivities } from '@temporalio/workflow';
import type { ActivityOptions, LocalActivityOptions } from '@temporalio/common';
import type { ModelActivityParameters, ModelSummaryProvider } from '../common/model-parameters';
import {
  type InvokeModelActivityInput,
  type JsonValue,
  type SerializedModelRequest,
  type SerializedModelResponse,
  WIRE_VERSION,
} from '../common/serialized-model';

export function toSerializedModelRequest(request: ModelRequest): SerializedModelRequest {
  return {
    __wireVersion: WIRE_VERSION,
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
    // signal: structurally absent from SerializedModelRequest
  };
}

function fromSerializedModelResponse(wire: SerializedModelResponse): ModelResponse {
  return {
    usage: new Usage(wire.usage as Record<string, unknown>),
    output: wire.output,
    responseId: wire.responseId,
    providerData: wire.providerData,
    // __wireVersion deliberately stripped — internal protocol field, not part of upstream ModelResponse.
    // Type assertion: JsonValue wire fields are structurally compatible with their upstream types at runtime.
  } as ModelResponse;
}

interface ModelActivities {
  invokeModelActivity(input: InvokeModelActivityInput): Promise<SerializedModelResponse>;
}

/**
 * A Model implementation that delegates to a Temporal activity.
 * Replaces the agent's real model in workflow context, ensuring all LLM calls
 * go through the activity worker where real ModelProviders live.
 */
export class ActivityBackedModel implements Model {
  private readonly activities: ModelActivities;
  private readonly modelParams: ModelActivityParameters;
  private agent?: Agent<any, any>;

  constructor(
    private readonly modelName: string,
    modelParams: ModelActivityParameters
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
      const activitiesWithOptions = this.activities as any;
      if (typeof activitiesWithOptions.invokeModelActivity?.executeWithOptions !== 'function') {
        throw new Error(
          'ModelSummaryProvider requires executeWithOptions on the activity proxy, ' +
            'but it is not available. Use a string summaryOverride instead, or ensure ' +
            'the activity proxy supports per-call options.'
        );
      }
      const wireResponse = (await activitiesWithOptions.invokeModelActivity.executeWithOptions({ summary }, [
        input,
      ])) as SerializedModelResponse;
      return fromSerializedModelResponse(wireResponse);
    }

    return fromSerializedModelResponse(await this.activities.invokeModelActivity(input));
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error(
      'Streaming is not supported in Temporal workflows. ' + 'Use non-streaming mode with TemporalOpenAIRunner.'
    );
  }
}
