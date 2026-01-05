import { Agent, AgentInputItem, Handoff, IndividualRunOptions, Model, ModelProvider, ModelRequest, ModelResponse, NonStreamRunOptions, RunConfig, RunContext, Runner, RunResult, RunState, StreamedRunResult, StreamEvent, StreamRunOptions, tool } from '@openai/agents';
import { TemporalModel } from './model';

function convertAgentToTemporalAgent<TAgent extends Agent<any, any>>(agent: TAgent): TAgent {
  if (typeof agent.model !== 'string') {
    throw new Error("TemporalRunner only supports string models");
  }

  const newHandoffs = agent.handoffs.map(handoff => {

    async function onInvokeHandoff(
      context: RunContext<any>,
      args: string,
    ) {
      if (handoff instanceof Handoff) {
        const newAgent = await handoff.onInvokeHandoff(context, args);
        return convertAgentToTemporalAgent(newAgent);
      }
      throw new Error("Handoff invocation should not have been called on an agent.");
    }

    if (handoff instanceof Agent) {
      return convertAgentToTemporalAgent(handoff);
    } else if (handoff instanceof Handoff) {
      const newHandoff = new Handoff(convertAgentToTemporalAgent(handoff.agent), onInvokeHandoff);
      newHandoff.inputFilter = handoff.inputFilter;
      newHandoff.inputJsonSchema = handoff.inputJsonSchema;
      newHandoff.strictJsonSchema = handoff.strictJsonSchema;
      newHandoff.toolName = handoff.toolName;
      newHandoff.toolDescription = handoff.toolDescription;

      return newHandoff;
    }
    return handoff;
  });

  return agent.clone({
    model: new TemporalModel(agent.model),
    handoffs: newHandoffs,
  }) as TAgent;
}

export class TemporalRunner extends Runner {
  constructor(config?: Partial<RunConfig>) {
    super(config);
  }

  run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options?: NonStreamRunOptions<TContext>
  ): Promise<RunResult<TContext, TAgent>>;
  run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options?: StreamRunOptions<TContext>
  ): Promise<StreamedRunResult<TContext, TAgent>>;
  run<TAgent extends Agent<any, any>, TContext = undefined>(
    agent: TAgent,
    input: string | AgentInputItem[] | RunState<TContext, TAgent>,
    options?: IndividualRunOptions<TContext>
  ): Promise<RunResult<TContext, TAgent> | StreamedRunResult<TContext, TAgent>> {
    if (options?.stream) {
      throw new Error('Streaming is not supported for TemporalRunner');
    }

    return super.run(convertAgentToTemporalAgent(agent), input, options as NonStreamRunOptions<TContext> | undefined);
  }
}
