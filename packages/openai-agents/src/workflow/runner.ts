import {
  Agent,
  Runner,
  type AgentOutputType,
  type CallModelInputFilter,
  type HandoffInputData,
  type InputGuardrail,
  type ModelSettings,
  type OutputGuardrail,
  type RunResult,
  type Session,
  type SessionInputCallback,
  type TracingConfig,
} from '@openai/agents-core';
import { ApplicationFailure } from '@temporalio/common';
import { DEFAULT_MODEL_ACTIVITY_OPTIONS, type ModelActivityOptions } from '../common/model-activity-options';
import { unwrapTemporalFailure } from '../common/errors';
import { DummyModelProvider } from './dummy-model-provider';
import { convertAgent } from './convert-agent';
import { ensureTracingProcessorRegistered } from './tracing';

export interface TemporalRunOptions<TContext = undefined> {
  /** Run context passed to agents and tools */
  context?: TContext;
  /** Maximum agent loop turns before aborting */
  maxTurns?: number;
  /** Previous OpenAI response ID for conversation continuity */
  previousResponseId?: string;
  /** OpenAI conversation ID for multi-turn persistence */
  conversationId?: string;
  /** Session state for conversation memory */
  session?: Session;
  /** Customize how session history merges with current turn input */
  sessionInputCallback?: SessionInputCallback;
  /** Edit system instructions or input items just before calling the model */
  callModelInputFilter?: CallModelInputFilter;
  /** Per-run tracing config override */
  tracing?: TracingConfig;
  // signal intentionally omitted — use Temporal CancellationScope for workflow cancellation

  /** Runner-level config overrides */
  runConfig?: {
    /** Model name override (string only — Model objects can't cross the workflow/activity boundary) */
    model?: string;
    /** Global model settings (temperature, topP, etc.). Non-null values override agent-specific settings. */
    modelSettings?: ModelSettings;
    /** Global handoff input filter. Agent-level inputFilter takes precedence. */
    handoffInputFilter?: (input: HandoffInputData) => HandoffInputData;
    /** Input guardrails run inline in the workflow — callbacks must be deterministic */
    inputGuardrails?: InputGuardrail[];
    /** Output guardrails run inline in the workflow — callbacks must be deterministic */
    outputGuardrails?: OutputGuardrail<AgentOutputType<unknown>>[];
    /** Disable tracing for this run */
    tracingDisabled?: boolean;
    /** Include sensitive data (tool I/O, LLM outputs) in trace spans */
    traceIncludeSensitiveData?: boolean;
    /** Logical name for the run, used in tracing */
    workflowName?: string;
    /** Custom trace ID */
    traceId?: string;
    /** Grouping ID for linking traces (e.g., chat thread ID) */
    groupId?: string;
    /** Additional metadata attached to the trace */
    traceMetadata?: Record<string, string>;
  };
}

export interface TemporalOpenAIRunnerOptions extends ModelActivityOptions {
  /**
   * When `true`, emit OTel spans even during workflow replay. Defaults to `false`.
   * Useful for debugging replay-divergence issues where trace output helps identify
   * which spans differ between original execution and replay.
   */
  startSpansInReplay?: boolean;
}

/**
 * A Temporal-aware agent runner that delegates model calls to activities.
 *
 * Streaming is not supported in Temporal workflows because activities are
 * request-response. Use run() for all agent invocations.
 */
export class TemporalOpenAIRunner {
  private readonly modelParams: ModelActivityOptions;

  constructor(options?: TemporalOpenAIRunnerOptions) {
    const { startSpansInReplay, ...modelParams } = options ?? {};
    this.modelParams = { ...DEFAULT_MODEL_ACTIVITY_OPTIONS, ...modelParams };
    ensureTracingProcessorRegistered({ startSpansInReplay });
  }

  /**
   * Run an agent in workflow context. Model calls are delegated to activities
   * via ActivityBackedModel, while the agent loop runs durably in the workflow.
   */
  async run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string,
    options?: TemporalRunOptions<TContext>
  ): Promise<RunResult<any, TAgent>> {
    const { model: modelOverride, ...runnerConfigOverrides } = options?.runConfig ?? {};

    const converted = convertAgent(agent, this.modelParams, undefined, modelOverride);

    const internalRunner = new Runner({
      modelProvider: new DummyModelProvider(),
      ...runnerConfigOverrides,
    });

    try {
      return (await internalRunner.run(converted, input, {
        maxTurns: options?.maxTurns,
        context: options?.context,
        previousResponseId: options?.previousResponseId,
        conversationId: options?.conversationId,
        session: options?.session,
        sessionInputCallback: options?.sessionInputCallback,
        callModelInputFilter: options?.callModelInputFilter,
        tracing: options?.tracing,
      })) as RunResult<any, TAgent>;
    } catch (error) {
      const temporalFailure = unwrapTemporalFailure(error);
      if (temporalFailure) throw temporalFailure;
      if (error instanceof Error) {
        throw ApplicationFailure.create({
          message: `Agent workflow failed: ${error.message}`,
          type: 'AgentsWorkflowError',
          nonRetryable: true,
          cause: error,
        });
      }
      throw error;
    }
  }
}
