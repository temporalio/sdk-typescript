/**
 * Helpers for wiring Temporal activities into Strands' tool and hook surfaces.
 *
 * Both {@link activityAsTool} and {@link activityAsHook} produce workflow-side
 * objects that dispatch user activities via {@link workflow.executeActivity},
 * so the I/O actually happens off the workflow.
 *
 * @module
 */

import type { HookableEvent, HookCallback } from '@strands-agents/sdk';
import * as workflow from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/workflow';
import { TemporalActivityTool, type ActivityAsToolOptions } from './temporal-activity-tool';

/**
 * Wrap a Temporal activity as a Strands tool.
 *
 * `activityName` must match the `name` registered on the worker (which
 * defaults to the activity function's name). The returned {@link Tool}
 * can be passed directly in {@link AgentConfig.tools}.
 */
export function activityAsTool(activityName: string, options: ActivityAsToolOptions = {}): TemporalActivityTool {
  return new TemporalActivityTool(activityName, options);
}

/**
 * Options for {@link activityAsHook}.
 *
 * `activityInput` extracts a serializable value from the event to pass as
 * the activity's input. This is needed because events hold references to
 * the `Agent` and `Tool` instances, which are not serializable.
 */
export interface ActivityAsHookOptions<E extends HookableEvent, I> {
  activityInput: (event: E) => I;
  activityOptions?: ActivityOptions;
}

/**
 * Wrap a Temporal activity as a Strands hook callback.
 *
 * The returned callback dispatches `activityName` as a Temporal activity
 * each time the associated event fires. Register the callback with
 * {@link Agent.addHook} or a {@link Plugin}'s hook registration.
 */
export function activityAsHook<E extends HookableEvent, I>(
  activityName: string,
  options: ActivityAsHookOptions<E, I>
): HookCallback<E> {
  const activityOptions: ActivityOptions = {
    startToCloseTimeout: '10 minutes',
    ...(options.activityOptions ?? {}),
  };
  return async function activityHookCallback(event: E): Promise<void> {
    const activities = workflow.proxyActivities<{
      [key: string]: (input: I) => Promise<unknown>;
    }>(activityOptions);
    await activities[activityName]!(options.activityInput(event));
  };
}
