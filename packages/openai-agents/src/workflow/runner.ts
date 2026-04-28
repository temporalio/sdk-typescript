import { Agent, Handoff, Runner, type Model, type RunResult } from '@openai/agents-core';
import { ApplicationFailure } from '@temporalio/common';
import { DEFAULT_MODEL_ACTIVITY_OPTIONS, type ModelActivityOptions } from '../common/model-activity-options';
import { AgentsWorkflowError } from '../common/errors';
import { DummyModelProvider } from './dummy-model-provider';
import { TEMPORAL_ACTIVITY_TOOL_MARKER } from './tools';
import { unwrapTemporalFailure, convertAgent } from './convert-agent';
import { ensureTracingProcessorRegistered } from './tracing';

export interface TemporalRunOptions<TContext = undefined> {
  context?: TContext;
  maxTurns?: number;
  previousResponseId?: string;
  runConfig?: {
    model?: string | Model;
  };
}

/**
 * A Temporal-aware agent runner that delegates model calls to activities.
 */
export class TemporalOpenAIRunner {
  private readonly modelParams: ModelActivityOptions;

  constructor(modelParams?: ModelActivityOptions) {
    this.modelParams = { ...DEFAULT_MODEL_ACTIVITY_OPTIONS, ...modelParams };
    ensureTracingProcessorRegistered();
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
    this.validateTools(agent);

    let modelNameOverride: string | undefined;
    if (options?.runConfig?.model !== undefined) {
      if (typeof options.runConfig.model === 'string') {
        modelNameOverride = options.runConfig.model;
      } else {
        throw ApplicationFailure.create({
          message:
            'RunConfig.model must be a string in Temporal workflows. ' +
            'Model objects cannot be serialized across the workflow/activity boundary.',
          type: 'AgentsWorkflowError',
          nonRetryable: true,
        });
      }
    }

    const converted = convertAgent(agent, this.modelParams, undefined, modelNameOverride);

    const internalRunner = new Runner({
      modelProvider: new DummyModelProvider(),
    });

    try {
      return (await internalRunner.run(converted, input, {
        maxTurns: options?.maxTurns,
        context: options?.context,
        previousResponseId: options?.previousResponseId,
      })) as RunResult<any, TAgent>;
    } catch (error) {
      const temporalFailure = unwrapTemporalFailure(error);
      if (temporalFailure) throw temporalFailure;
      if (error instanceof Error) {
        const wrapped = new AgentsWorkflowError(`Agent workflow failed: ${error.message}`, { cause: error });
        throw ApplicationFailure.create({
          message: wrapped.message,
          type: 'AgentsWorkflowError',
          nonRetryable: true,
          cause: wrapped,
        });
      }
      throw error;
    }
  }

  /**
   * Streaming is not supported in Temporal workflows because activities are
   * request-response. Call this and it throws immediately with a clear message.
   * Use run() for non-streaming agent invocations.
   */
  runStreamed<TAgent extends Agent<any, any>, TContext = undefined>(
    _agent: TAgent,
    _input: string,
    _options?: TemporalRunOptions<TContext>
  ): never {
    throw ApplicationFailure.create({
      message: 'Streaming is not supported in Temporal workflows. Use run() instead.',
      type: 'AgentsWorkflowError',
      nonRetryable: true,
    });
  }

  private validateTools(agent: Agent<any, any>, visited?: Set<Agent<any, any>>): void {
    visited = visited ?? new Set();
    if (visited.has(agent)) return;
    visited.add(agent);

    const tools: unknown[] = (agent as any).tools ?? [];
    for (const t of tools) {
      if (typeof t === 'function') {
        throw ApplicationFailure.create({
          message:
            `Agent '${agent.name}': Provided tool is not a tool type. ` +
            'If using an activity, make sure to wrap it with activityAsTool.',
          type: 'AgentsWorkflowError',
          nonRetryable: true,
        });
      }
      if (
        t &&
        typeof t === 'object' &&
        (t as any).type === 'function' &&
        typeof (t as any).invoke === 'function' &&
        !(t as any)[TEMPORAL_ACTIVITY_TOOL_MARKER]
      ) {
        throw ApplicationFailure.create({
          message:
            `Agent '${agent.name}': Function tool was not created via activityAsTool. ` +
            'User-defined tools must be wrapped with activityAsTool() because ' +
            'raw tool invocations run in the workflow sandbox and cannot perform I/O.',
          type: 'AgentsWorkflowError',
          nonRetryable: true,
        });
      }
    }

    const handoffs: unknown[] = (agent as any).handoffs ?? [];
    for (const h of handoffs) {
      if (h instanceof Handoff) {
        this.validateTools(h.agent, visited);
      } else if (h instanceof Agent) {
        this.validateTools(h as Agent<any, any>, visited);
      }
    }
  }
}
