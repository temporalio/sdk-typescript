import type { temporal } from '@temporalio/proto';

/**
 * Priority contains metadata that controls relative ordering of task processing when tasks are
 * backlogged in a queue. Initially, Priority will be used in activity and workflow task queues,
 * which are typically where backlogs exist.
 * Priority is (for now) attached to workflows and activities. Activities and child workflows
 * inherit Priority from the workflow that created them, but may override fields when they are
 * started or modified. For each field of a Priority on an activity/workflow, not present or equal
 * to zero/empty string means to inherit the value from the calling workflow, or if there is no
 * calling workflow, then use the default (documented on the field).
 * The overall semantics of Priority are:
 * 1. First, consider "priority_key": lower number goes first.
 * 2. Then, consider fairness: the fairness mechanism attempts to dispatch tasks for a given key in
 *    proportion to its weight.
 */
export interface Priority {
  /**
   * Priority key is a positive integer from 1 to n, where smaller integers
   * correspond to higher priorities (tasks run sooner). In general, tasks in
   * a queue should be processed in close to priority order, although small
   * deviations are possible.
   *
   * The maximum priority value (minimum priority) is determined by server configuration, and
   * defaults to 5.
   *
   * The default priority is (min+max)/2. With the default max of 5 and min of 1, that comes out to 3.
   */
  priorityKey?: number;

  /**
   * FairnessKey is a short string that's used as a key for a fairness
   * balancing mechanism. It may correspond to a tenant id, or to a fixed
   * string like "high" or "low". The default is the empty string.
   *
   * The fairness mechanism attempts to dispatch tasks for a given key in
   * proportion to its weight. For example, using a thousand distinct tenant
   * ids, each with a weight of 1.0 (the default) will result in each tenant
   * getting a roughly equal share of task dispatch throughput.
   *
   * Fairness keys are limited to 64 bytes.
   */
  fairnessKey?: string;

  /**
   * FairnessWeight for a task can come from multiple sources for
   * flexibility. From highest to lowest precedence:
   * 1. Weights for a small set of keys can be overridden in task queue
   *    configuration with an API.
   * 2. It can be attached to the workflow/activity in this field.
   * 3. The default weight of 1.0 will be used.
   *
   * Weight values are clamped to the range [0.001, 1000].
   */
  fairnessWeight?: number;
}

/**
 * Turn a proto compatible Priority into a TS Priority
 */
export function decodePriority(priority?: temporal.api.common.v1.IPriority | null): Priority {
  return {
    priorityKey: priority?.priorityKey ?? undefined,
    fairnessKey: priority?.fairnessKey ?? undefined,
    fairnessWeight: priority?.fairnessWeight ?? undefined,
  };
}

/**
 * Turn a TS Priority into a proto compatible Priority
 */
export function compilePriority(priority: Priority): temporal.api.common.v1.IPriority {
  if (priority.priorityKey !== undefined && priority.priorityKey !== null) {
    if (!Number.isInteger(priority.priorityKey)) {
      throw new TypeError('priorityKey must be an integer');
    }
    if (priority.priorityKey < 0) {
      throw new RangeError('priorityKey must be a positive integer');
    }
  }

  return {
    priorityKey: priority.priorityKey ?? 0,
    fairnessKey: priority.fairnessKey ?? '',
    fairnessWeight: priority.fairnessWeight ?? 0,
  };
}
