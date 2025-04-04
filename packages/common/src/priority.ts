// TODO: type import here?
import { temporal } from '@temporalio/proto';

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
 * (more will be added here later)
 */
export class Priority {
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
  public readonly priorityKey?: number;

  static readonly default = new Priority(undefined);

  constructor(priorityKey?: number) {
    if (priorityKey !== undefined && priorityKey !== null) {
      if (!Number.isInteger(priorityKey)) {
        throw new TypeError('priorityKey must be an integer');
      }
      if (priorityKey < 1) {
        throw new RangeError('priorityKey must be a positive integer');
      }
    }
    this.priorityKey = priorityKey ?? undefined;
  }

  /**
   * Create a `Priority` instance from the protobuf message.
   */
  static fromProto(proto: temporal.api.common.v1.IPriority | null | undefined): Priority {
    return new Priority(proto?.priorityKey ?? undefined);
  }

  /**
   * Convert this instance to a protobuf message.
   */
  toProto(): temporal.api.common.v1.Priority {
    return temporal.api.common.v1.Priority.create({
      priorityKey: this.priorityKey ?? 0,
    });
  }
}