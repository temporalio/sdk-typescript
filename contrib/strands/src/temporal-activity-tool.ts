import {
  JsonBlock,
  TextBlock,
  Tool,
  ToolResultBlock,
  type JSONSchema,
  type JSONValue,
  type ToolContext,
  type ToolSpec,
  type ToolStreamGenerator,
} from '@strands-agents/sdk';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import { ActivityFailure, ApplicationFailure } from '@temporalio/common';
import { STRANDS_INTERRUPT_TYPE } from './failure-converter';

/**
 * Options accepted by {@link activityAsTool}.
 *
 * `name` defaults to the activity function's `.name`. `description` defaults
 * to an empty string and SHOULD be supplied so the model has signal about
 * when to call the tool. `inputSchema` is the JSON Schema that describes
 * the activity's single argument; pass a literal JSON Schema object, or use
 * a Zod schema with {@link https://github.com/StefanTerdell/zod-to-json-schema | zod-to-json-schema}
 * to derive one.
 */
export interface ActivityAsToolOptions {
  name?: string;
  description?: string;
  inputSchema?: JSONSchema;
  activityOptions?: ActivityOptions;
}

/**
 * A Strands {@link Tool} whose body dispatches a Temporal activity via
 * {@link workflow.executeActivity}.
 *
 * When the activity fails with an {@link ApplicationFailure} whose `type`
 * matches {@link STRANDS_INTERRUPT_TYPE} — see {@link StrandsFailureConverter} —
 * `stream()` re-throws an {@link InterruptError} so the agent loop handles
 * the interrupt the same way as a hook- or tool-body interrupt. Other
 * failures are converted to an error {@link ToolResultBlock}.
 */
export class TemporalActivityTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: ToolSpec;
  private readonly activityName: string;
  private readonly activityOptions: ActivityOptions;

  constructor(
    activityName: string,
    options: { name?: string; description?: string; inputSchema?: JSONSchema; activityOptions?: ActivityOptions }
  ) {
    super();
    this.activityName = activityName;
    this.name = options.name ?? activityName;
    this.description = options.description ?? '';
    this.toolSpec = {
      name: this.name,
      description: this.description,
      inputSchema: options.inputSchema ?? { type: 'object', properties: {} },
    };
    this.activityOptions = options.activityOptions ?? {};
  }

  // eslint-disable-next-line require-yield
  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const { toolUseId, input } = toolContext.toolUse;
    const activities = workflow.proxyActivities<{
      [key: string]: (input: JSONValue) => Promise<unknown>;
    }>({
      startToCloseTimeout: '10 minutes',
      summary: this.name,
      ...this.activityOptions,
    });
    let activityResult: unknown;
    try {
      activityResult = await activities[this.activityName]!(input);
    } catch (err) {
      if (
        err instanceof ActivityFailure &&
        err.cause instanceof ApplicationFailure &&
        err.cause.type === STRANDS_INTERRUPT_TYPE
      ) {
        const details = (err.cause.details ?? []) as Array<{
          name: string;
          reason?: unknown;
          response?: unknown;
        }>;
        const first = details[0];
        // Route through the agent's interrupt() helper: throws InterruptError to
        // halt on first call, returns the user's response on resume.
        const response = toolContext.interrupt<unknown>({
          name: first?.name ?? 'interrupt',
          reason: first?.reason as JSONValue,
        });
        return new ToolResultBlock({
          toolUseId,
          status: 'success',
          content: [toResultContent(response)],
        });
      }
      return new ToolResultBlock({
        toolUseId,
        status: 'error',
        content: [new TextBlock(String(err instanceof Error ? err.message : err))],
      });
    }
    return new ToolResultBlock({
      toolUseId,
      status: 'success',
      content: [toResultContent(activityResult)],
    });
  }
}

function toResultContent(value: unknown): TextBlock | JsonBlock {
  if (typeof value === 'string') return new TextBlock(value);
  return new JsonBlock({ json: value as JSONValue });
}
