import {
  Usage,
  withGenerationSpan,
  type Agent,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents-core';
import { proxyActivities, proxyLocalActivities } from '@temporalio/workflow';
import type { ActivityOptions, LocalActivityOptions } from '@temporalio/common';
import type { ModelActivityOptions, ModelSummaryProvider } from '../common/model-activity-options';
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
    // input is string | AgentInputItem[] — both are Zod-inferred plain objects, JSON-safe.
    input: request.input as JsonValue,
    modelSettings: request.modelSettings,
    tools: request.tools,
    toolsExplicitlyProvided: request.toolsExplicitlyProvided,
    outputType: request.outputType,
    handoffs: request.handoffs,
    // Prompt is { promptId, version?, variables? } — plain object, JSON-safe.
    prompt: request.prompt as JsonValue | undefined,
    previousResponseId: request.previousResponseId,
    conversationId: request.conversationId,
    // ModelTracing is boolean | 'enabled_without_data' — already a JSON primitive.
    tracing: request.tracing as JsonValue,
    overridePromptModel: request.overridePromptModel,
  };
}

function fromSerializedModelResponse(wire: SerializedModelResponse): ModelResponse {
  // Usage is the only class instance in ModelResponse that needs reconstruction. Its add() method
  // is used by the Runner to accumulate token counts across turns. All AgentOutputItem variants in
  // output[] are Zod-inferred plain objects — they survive JSON round-trip without reconstruction.
  return {
    usage: new Usage(wire.usage as Record<string, unknown>),
    output: wire.output,
    responseId: wire.responseId,
    providerData: wire.providerData,
    // Cast: __wireVersion stripped (protocol-only). Remaining fields are structurally compatible
    // with ModelResponse at runtime — Usage is reconstructed above, output items are plain objects.
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
    // Upstream model adapters emit a generation span inside getResponse().
    // We mirror that here so the trace tree stays: agent → generation → activity.
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
    });
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error(
      'Streaming is not supported in Temporal workflows. ' + 'Use non-streaming mode with TemporalOpenAIRunner.'
    );
  }
}
