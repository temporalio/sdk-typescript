import { type FunctionDeclaration, type Schema, Type } from '@google/genai';
import { BaseTool, type Context, type RunAsyncToolRequest } from '@google/adk';
import { ApplicationFailure } from '@temporalio/common';
import { type ActivityOptions, inWorkflowContext, proxyActivities } from '@temporalio/workflow';

import { evaluateRequireConfirmation, gateOnConfirmation, type RequireConfirmation } from './confirmation';
import { ACTIVITY_TOOL_OUTSIDE_WORKFLOW_FAILURE_TYPE } from './error-types';
import { activityOptionsFrom } from './model';

/**
 * Options for {@link activityAsTool}.
 */
export interface ActivityAsToolOptions {
  /**
   * The registered Activity name to dispatch. Must match an `@activity`-style
   * function registered on the worker (e.g. via the worker's `activities`).
   */
  name: string;
  /** Description advertised to the model. */
  description: string;
  /**
   * Parameter schema advertised to the model. The model's tool-call arguments
   * are passed as the Activity's single argument. Defaults to an empty object
   * schema.
   */
  parameters?: Schema;
  /** Per-call Activity configuration (timeouts, retry, task queue). */
  activity?: ActivityOptions;
  /**
   * Gate the Activity behind human approval, like ADK's
   * `FunctionTool({ requireConfirmation })`. The Activity is NOT scheduled on
   * the pass that raises the confirmation request, nor after a rejection; it
   * runs once the resumed turn carries the approval (see `hitlConfirmationResponse`).
   *
   * A predicate must be a pure function of the arguments: ADK re-evaluates it
   * when binding the approval to the pinned call and refuses the approval if
   * it then answers `false`. Only enforced on an `LlmAgent` turn — ADK 2.0's
   * workflow `ToolNode` does not route through the confirmation path, so a
   * gated tool used directly as a graph node returns the "requires
   * confirmation" error as its output instead of pausing; use a `RequestInput`
   * node for graph-level approval.
   */
  requireConfirmation?: RequireConfirmation<Record<string, unknown>>;
}

/**
 * A {@link BaseTool} that dispatches a registered Temporal Activity.
 */
class ActivityTool extends BaseTool {
  private readonly parameters?: Schema;
  private readonly activityOptions?: ActivityOptions;
  private readonly requireConfirmation?: RequireConfirmation<Record<string, unknown>>;

  constructor(options: ActivityAsToolOptions) {
    super({ name: options.name, description: options.description });
    this.parameters = options.parameters;
    this.activityOptions = options.activity;
    this.requireConfirmation = options.requireConfirmation;
  }

  /** Advertises the tool's name, description, and parameter schema. */
  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters ?? { type: Type.OBJECT, properties: {} },
    };
  }

  /**
   * Whether a call with `args` needs human approval — the declarative side of
   * the gate, which ADK consults when binding an approval to the pinned call.
   */
  override async checkRequireConfirmation(args: Record<string, unknown>, toolContext?: Context): Promise<boolean> {
    return evaluateRequireConfirmation(this.requireConfirmation, args, toolContext);
  }

  /** Dispatches the named Activity with the model-provided arguments. */
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    if (!inWorkflowContext()) {
      throw ApplicationFailure.nonRetryable(
        `activityAsTool('${this.name}') can only run inside a Temporal Workflow.`,
        ACTIVITY_TOOL_OUTSIDE_WORKFLOW_FAILURE_TYPE
      );
    }
    if (await this.checkRequireConfirmation(request.args, request.toolContext)) {
      const gated = gateOnConfirmation(this.name, request.toolContext);
      if (gated !== undefined) return gated;
    }
    const activities = proxyActivities<Record<string, (args: Record<string, unknown>) => Promise<unknown>>>(
      activityOptionsFrom(this.activityOptions, `adk.tool ${this.name}`)
    );
    // `proxyActivities` returns a Proxy that materializes a stub for any name,
    // so the indexed access is always defined; `noUncheckedIndexedAccess`
    // widens the static type to `| undefined`, hence the assertion.
    const activity = activities[this.name]!;
    return activity(request.args);
  }
}

/**
 * Wraps an existing Temporal Activity (by registered name) as an ADK
 * {@link BaseTool}. Add the returned tool to an agent's `tools[]`.
 */
export function activityAsTool(options: ActivityAsToolOptions): BaseTool {
  return new ActivityTool(options);
}
