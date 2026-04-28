/**
 * Upstream version contracts — @openai/agents-core ~0.3.0
 *
 * This module depends on three implicit contracts from the upstream library:
 *
 * 1. Agent.clone({ model }) — accepts a Model override and returns a new Agent
 *    with the same configuration except the model field.
 * 2. Handoff.onInvokeHandoff(ctx, args): Promise<Agent> — the next-agent callback
 *    invoked by the runner when a handoff is triggered.
 * 3. Agent.handoffs — iterable as (Agent | Handoff)[]. Each entry is either a bare
 *    Agent (auto-wrapped by the runner) or a Handoff instance.
 *
 * When upgrading @openai/agents-core, re-verify these contracts against the new
 * version's source/types before merging.
 */
import { Agent, Handoff } from '@openai/agents-core';
import { ApplicationFailure } from '@temporalio/common';
import type { ModelActivityOptions } from '../common/model-activity-options';
import { ActivityBackedModel } from './activity-backed-model';
import { getAgentInternals } from './agent-internals';

/**
 * Recursively convert an agent graph, replacing each agent's model
 * with an ActivityBackedModel. Uses a seen map to handle circular handoff references.
 */
export function convertAgent(
  agent: Agent<any, any>,
  modelParams: ModelActivityOptions,
  seen?: Map<Agent<any, any>, Agent<any, any>>,
  modelNameOverride?: string
): Agent<any, any> {
  seen = seen ?? new Map();
  if (seen.has(agent)) return seen.get(agent)!;

  const internals = getAgentInternals(agent);
  const rawModel = internals.model;
  if (rawModel !== undefined && rawModel !== null && typeof rawModel !== 'string') {
    throw ApplicationFailure.create({
      message:
        `Agent '${agent.name}' has a Model object instead of a string model name. ` +
        'In Temporal workflows, use string model names (resolved by ModelProvider on the activity side).',
      type: 'AgentsWorkflowError',
      nonRetryable: true,
    });
  }
  const modelName = modelNameOverride ?? (typeof rawModel === 'string' ? rawModel : undefined);
  if (modelName === undefined) {
    throw ApplicationFailure.create({
      message:
        `Agent '${agent.name}' has no model declared and no runConfig.model override given. ` +
        'Declare a model on the agent or pass runConfig.model to runner.run().',
      type: 'AgentsWorkflowError',
      nonRetryable: true,
    });
  }
  const activityBackedModel = new ActivityBackedModel(modelName, modelParams);
  // Pass the ORIGINAL agent (pre-clone) so the summary provider sees the
  // user-declared `name` and `instructions`, not the wrapper. The cloned
  // agent has the same field values today, but binding to the original
  // makes that invariance explicit and survives any future clone-side
  // mutation.
  activityBackedModel.setAgent(agent);

  const converted = agent.clone({ model: activityBackedModel });
  seen.set(agent, converted);

  const convertedHandoffs = (internals.handoffs ?? []).map((h: unknown) => {
    if (h instanceof Handoff) {
      const convertedHandoffAgent = convertAgent(h.agent, modelParams, seen, modelNameOverride);
      const originalOnInvoke = h.onInvokeHandoff;
      const wrappedOnInvoke = async (ctx: any, args: string) => {
        await originalOnInvoke(ctx, args);
        return convertedHandoffAgent;
      };
      const newHandoff = Object.create(Object.getPrototypeOf(h), Object.getOwnPropertyDescriptors(h)) as Handoff<
        any,
        any
      >;
      newHandoff.agent = convertedHandoffAgent;
      newHandoff.onInvokeHandoff = wrappedOnInvoke;
      return newHandoff;
    }
    return convertAgent(h as Agent<any, any>, modelParams, seen, modelNameOverride);
  });

  converted.handoffs = convertedHandoffs;
  return converted;
}
