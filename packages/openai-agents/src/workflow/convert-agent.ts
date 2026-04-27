import { Agent, Handoff, type Model } from '@openai/agents-core';
import { ApplicationFailure, TemporalFailure } from '@temporalio/common';
import type { ModelActivityParameters } from '../common/model-parameters';
import { ActivityBackedModel } from './activity-backed-model';

export function unwrapTemporalFailure(error: unknown): TemporalFailure | undefined {
  const visited = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (current instanceof TemporalFailure) return current;
    if (current instanceof AggregateError) {
      for (const inner of current.errors) {
        stack.push(inner);
      }
    }
    stack.push((current as any).cause);
  }
  return undefined;
}

/**
 * Recursively convert an agent graph, replacing each agent's model
 * with an ActivityBackedModel. Uses a seen map to handle circular handoff references.
 */
export function convertAgent(
  agent: Agent<any, any>,
  modelParams: ModelActivityParameters,
  seen?: Map<Agent<any, any>, Agent<any, any>>,
  modelNameOverride?: string
): Agent<any, any> {
  seen = seen ?? new Map();
  if (seen.has(agent)) return seen.get(agent)!;

  const rawModel = (agent as any).model;
  if (rawModel !== undefined && rawModel !== null && typeof rawModel !== 'string') {
    throw ApplicationFailure.create({
      message:
        `Agent '${agent.name}' has a Model object instead of a string model name. ` +
        'In Temporal workflows, use string model names (resolved by ModelProvider on the activity side).',
      type: 'AgentsWorkflowError',
      nonRetryable: true,
    });
  }
  const modelName = modelNameOverride ?? (typeof rawModel === 'string' ? rawModel : 'default');
  const activityBackedModel = new ActivityBackedModel(modelName, modelParams);
  // Pre-clone agent: summary provider needs the original agent's instructions/name
  activityBackedModel.setAgent(agent);

  const converted = agent.clone({ model: activityBackedModel as Model });
  seen.set(agent, converted);

  const convertedHandoffs = ((agent as any).handoffs ?? []).map((h: Agent<any, any> | Handoff<any, any>) => {
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
    return convertAgent(h, modelParams, seen, modelNameOverride);
  });

  converted.handoffs = convertedHandoffs;
  return converted;
}
