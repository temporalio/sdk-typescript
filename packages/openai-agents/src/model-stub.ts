import type {
  Agent,
  Model,
  ModelRequest,
  ModelResponse,
  ModelSettings,
  SerializedHandoff,
  SerializedOutputType,
  SerializedTool,
  StreamEvent,
} from '@openai/agents-core';
import { proxyActivities, proxyLocalActivities } from '@temporalio/workflow';
import type { ActivityOptions, LocalActivityOptions } from '@temporalio/common';
import type { ModelActivityParameters, ModelSummaryProvider } from './model-parameters';

/**
 * Serializable subset of ModelRequest that can be sent to an activity.
 * Strips non-serializable fields like AbortSignal.
 */
export interface ActivityModelInput {
  modelName: string;
  request: {
    systemInstructions?: string;
    input: unknown;
    // Prompt and ModelTracing are not publicly exported from @openai/agents-core
    prompt?: unknown;
    previousResponseId?: string;
    conversationId?: string;
    modelSettings: ModelSettings;
    tools: SerializedTool[];
    toolsExplicitlyProvided?: boolean;
    outputType: SerializedOutputType;
    handoffs: SerializedHandoff[];
    tracing: unknown;
    overridePromptModel?: boolean;
  };
}

interface ModelActivities {
  invokeModelActivity(input: ActivityModelInput): Promise<ModelResponse>;
}

/**
 * A Model implementation that delegates to a Temporal activity.
 * Replaces the agent's real model in workflow context, ensuring all LLM calls
 * go through the activity worker where real ModelProviders live.
 */
export class TemporalModelStub implements Model {
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
    // Strip non-serializable fields (AbortSignal, internal metadata)
    const { signal: _signal, _internal, ...serializableFields } = request as any;

    const input: ActivityModelInput = {
      modelName: this.modelName,
      request: serializableFields,
    };

    const summaryOverride = this.modelParams.summaryOverride;
    if (summaryOverride && typeof summaryOverride !== 'string') {
      const provider = summaryOverride as ModelSummaryProvider;
      const systemInstructions = serializableFields.systemInstructions;
      const summary = provider.provide(this.agent, systemInstructions, serializableFields.input);
      const activitiesWithOptions = this.activities as any;
      if (typeof activitiesWithOptions.invokeModelActivity?.executeWithOptions !== 'function') {
        throw new Error(
          'ModelSummaryProvider requires executeWithOptions on the activity proxy, ' +
            'but it is not available. Use a string summaryOverride instead, or ensure ' +
            'the activity proxy supports per-call options.'
        );
      }
      return await activitiesWithOptions.invokeModelActivity.executeWithOptions({ summary }, [input]);
    }

    return await this.activities.invokeModelActivity(input);
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error(
      'Streaming is not supported in Temporal workflows. ' + 'Use non-streaming mode with TemporalOpenAIRunner.'
    );
  }
}
