import type { FunctionTool, RunContext } from '@openai/agents-core';
import type { Duration, RetryPolicy } from '@temporalio/common';
import { proxyActivities } from '@temporalio/workflow';

export class ToolSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolSerializationError';
  }
}

// JsonObjectSchema is not publicly exported from @openai/agents-core — local equivalent
export interface JsonObjectSchema<_T = unknown> {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export const TEMPORAL_ACTIVITY_TOOL_MARKER = Symbol.for('temporal.activityAsTool');

/**
 * Definition for wrapping a Temporal activity as an agent tool.
 * The `activityFn` is used for TypeScript type inference only — it is never called directly.
 */
export interface ActivityToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Activity name — must match the registered activity on the worker */
  name: string;
  /** Tool description shown to the model */
  description: string;
  /** Explicit JSON schema for the tool parameters (not Zod) */
  parameters: JsonObjectSchema<TInput>;
  /** Activity function reference — used for type inference only, never called */
  activityFn: (input: TInput) => Promise<TOutput>;
}

/**
 * Options for controlling how the tool's activity is scheduled.
 */
export interface ActivityAsToolOptions {
  startToCloseTimeout?: Duration;
  heartbeatTimeout?: Duration;
  taskQueue?: string;
  retryPolicy?: RetryPolicy;
  strict?: boolean;
}

/**
 * Wrap a Temporal activity as an OpenAI Agents FunctionTool.
 * When the agent invokes this tool, it schedules the named activity
 * via `proxyActivities` and returns the stringified result.
 *
 * @param definition - Activity tool definition (name, description, JSON schema, type reference)
 * @param options - Activity scheduling options (timeouts, retry, task queue)
 */
export function activityAsTool<TInput, TOutput>(
  definition: ActivityToolDefinition<TInput, TOutput>,
  options?: ActivityAsToolOptions
): FunctionTool {
  const activities = proxyActivities<Record<string, (input: any) => Promise<any>>>({
    startToCloseTimeout: options?.startToCloseTimeout ?? '1 minute',
    heartbeatTimeout: options?.heartbeatTimeout,
    taskQueue: options?.taskQueue,
    retry: options?.retryPolicy,
  });

  const t = {
    type: 'function',
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters as any,
    strict: options?.strict ?? true,
    invoke: async (_runContext: RunContext<any>, input: string): Promise<string> => {
      let parsedInput: TInput;
      try {
        parsedInput = JSON.parse(input);
      } catch (e) {
        throw new ToolSerializationError(`Failed to parse tool input for '${definition.name}': ${e}`);
      }
      const activityFn = activities[definition.name];
      if (!activityFn) {
        throw new ToolSerializationError(`Activity '${definition.name}' not found`);
      }
      const result = await activityFn(parsedInput);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
    needsApproval: async () => false,
    isEnabled: async () => true,
  } as FunctionTool;

  (t as any)[TEMPORAL_ACTIVITY_TOOL_MARKER] = true;

  return t;
}
