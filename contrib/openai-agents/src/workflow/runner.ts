import {
  type Agent,
  type AgentInputItem,
  MemorySession,
  Runner,
  RunState,
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
import { convertAgent } from './convert-agent';
import { ensureTracingProcessorRegistered } from './tracing';
import { flushOpenSpans } from './agent-sink-processor';
import { getCurrentPluginConfig } from './plugin-config-store';

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
  // signal intentionally omitted — use Temporal CancellationScope for Workflow cancellation

  /** Runner-level config overrides */
  runConfig?: {
    /** Model name override (string only — Model objects can't cross the Workflow/Activity boundary) */
    model?: string;
    /** Global model settings (temperature, topP, etc.). Non-null values override agent-specific settings. */
    modelSettings?: ModelSettings;
    /** Global handoff input filter. Agent-level inputFilter takes precedence. */
    handoffInputFilter?: (input: HandoffInputData) => HandoffInputData;
    /** Input guardrails run inline in the Workflow — callbacks must be deterministic */
    inputGuardrails?: InputGuardrail[];
    /** Output guardrails run inline in the Workflow — callbacks must be deterministic */
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

/**
 * A Temporal-aware agent runner that delegates model calls to Activities.
 *
 * Streaming is not supported in Temporal Workflows because Activities are
 * request-response. Use run() for all agent invocations.
 */
export class TemporalOpenAIRunner {
  private readonly modelParams: ModelActivityOptions;

  constructor() {
    ensureTracingProcessorRegistered();
    const fromHeader = getCurrentPluginConfig();
    this.modelParams = fromHeader?.modelParams ?? DEFAULT_MODEL_ACTIVITY_OPTIONS;
  }

  /**
   * `input` accepts a prompt string, structured `AgentInputItem[]`, or a
   * deserialized `RunState` to resume a previous run across `continueAsNew`.
   * Capture the current `RunState` via `result.state.toString()`.
   */
  async run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options?: TemporalRunOptions<TContext>
  ): Promise<RunResult<any, TAgent>> {
    const session = options?.session;
    if (session instanceof MemorySession) {
      throw ApplicationFailure.create({
        message:
          'Pass WorkflowSafeMemorySession to TemporalOpenAIRunner.run({ session }); the upstream MemorySession is not safe inside a Workflow (heap-only state without Temporal Event History backing). See @temporalio/openai-agents/workflow.',
        type: 'UnsafeSessionError',
        nonRetryable: true,
      });
    }

    const { model: modelOverride, ...runnerConfigOverrides } = options?.runConfig ?? {};

    const converted = convertAgent(agent, this.modelParams, undefined, modelOverride);

    let preparedInput: string | AgentInputItem[] | RunState<TContext, TAgent>;
    if (input instanceof RunState) {
      // Round-trip through fromString so the rehydrated state's agent graph carries our converted
      // agent (with ActivityBackedModel); setCurrentAgent only swaps the top-level ref, not nested ones.
      const restored = (await RunState.fromString(converted, input.toString())) as RunState<TContext, TAgent>;
      // Suppress upstream Runner.run's withTrace(state._trace, ...) branch; we want the current Workflow's trace.
      restored.clearTrace();
      preparedInput = restored;
    } else {
      preparedInput = input;
    }

    const innerRunner = new Runner({ ...runnerConfigOverrides });

    try {
      return (await innerRunner.run(converted, preparedInput as any, {
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
      throw normalizeAgentsRunError(error);
    } finally {
      await flushOpenSpans();
    }
  }
}

/**
 * Returns the value the caller should throw: unwrapped TemporalFailure if
 * reachable via `cause` / `AggregateError.errors`, else an `AgentsWorkflowError`
 * ApplicationFailure wrapping a plain Error, else the original non-Error.
 */
export function normalizeAgentsRunError(error: unknown): unknown {
  const temporalFailure = unwrapTemporalFailure(error);
  if (temporalFailure) return temporalFailure;
  if (error instanceof Error) {
    return ApplicationFailure.create({
      message: `Agent workflow failed: ${error.message}`,
      type: 'AgentsWorkflowError',
      nonRetryable: true,
      cause: error,
    });
  }
  return error;
}
