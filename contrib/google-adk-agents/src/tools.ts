/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 */

import { type FunctionDeclaration, type Schema, Type } from '@google/genai';
import { BaseTool, type RunAsyncToolRequest } from '@google/adk';
import { ApplicationFailure, type ActivityOptions } from '@temporalio/common';
import { inWorkflowContext, proxyActivities } from '@temporalio/workflow';

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
}

/**
 * A {@link BaseTool} that dispatches a registered Temporal Activity.
 */
class ActivityTool extends BaseTool {
  private readonly parameters?: Schema;
  private readonly activityOptions?: ActivityOptions;

  constructor(options: ActivityAsToolOptions) {
    super({ name: options.name, description: options.description });
    this.parameters = options.parameters;
    this.activityOptions = options.activity;
  }

  /** Advertises the tool's name, description, and parameter schema. */
  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters ?? { type: Type.OBJECT, properties: {} },
    };
  }

  /** Dispatches the named Activity with the model-provided arguments. */
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    if (!inWorkflowContext()) {
      throw ApplicationFailure.nonRetryable(
        `activityAsTool('${this.name}') can only run inside a Temporal Workflow.`,
        'GoogleAdkActivityToolOutsideWorkflow'
      );
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
