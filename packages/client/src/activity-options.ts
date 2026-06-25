import type {
  ActivityFunction,
  Priority,
  RetryPolicy,
  SearchAttributePair,
  TypedSearchAttributes,
} from '@temporalio/common';
import type { Duration } from '@temporalio/common/lib/time';
import type { Replace } from '@temporalio/common/lib/type-helpers';
import type { ActivityIdConflictPolicy, ActivityIdReusePolicy } from './types';

/**
 * Options used by {@link ActivityClient.start}.
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export interface ActivityOptions {
  /**
   * Activity ID of the started activity. It's recommended to use a meaningful business ID.
   */
  id: string;
  /**
   * Task queue to run this activity on.
   */
  taskQueue: string;
  /**
   * Input arguments to pass to the activity.
   */
  args?: any[] | Readonly<any[]>;
  /**
   * If set, specifies maximum time between successful heartbeats.
   */
  heartbeatTimeout?: Duration;
  /**
   * Controls how Activity is retried. If not set, the server will assign default retry policy.
   */
  retry?: RetryPolicy;
  /**
   * Is set, specifies total time the activity is allowed to run, including retries.
   *
   * Note: it is required to set at least one of {@link startToCloseTimeout} and {@link scheduleToCloseTimeout}.
   */
  startToCloseTimeout?: Duration;
  /**
   * If set, specifies maximum time the activity can wait in the task queue before being picked up by a worker.
   * This timeout is non-retryable.
   */
  scheduleToStartTimeout?: Duration;
  /**
   * If set, specifies maximum time for a single execution attempt. This timeout is retryable.
   *
   * Note: it is required to set at least one of {@link startToCloseTimeout} and {@link scheduleToCloseTimeout}.
   */
  scheduleToCloseTimeout?: Duration;
  /**
   * A single-line fixed summary for this activity execution that may appear in UI/CLI.
   * This can be in single-line Temporal markdown format.
   */
  summary?: string;
  /**
   * Priority to use when starting this activity.
   */
  priority?: Priority;
  /**
   * Time to wait before dispatching the first activity task. This delay is not applied to retry attempts.
   */
  startDelay?: Duration;
  /**
   * Specifies behavior if there's a *closed* activity with the same ID.
   */
  idReusePolicy?: ActivityIdReusePolicy;
  /**
   * Specifies behavior if there's a *running* activity with the same ID. Note that there can only be one running
   * Activity for each Activity ID.
   */
  idConflictPolicy?: ActivityIdConflictPolicy;
  /**
   * Search attributes for the activity.
   */
  typedSearchAttributes?: SearchAttributePair[] | TypedSearchAttributes;
}

/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Contains names of activities extracted from the specified activity interface.
 * @template T Activity interface
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export type ActivityName<T> = {
  [N in keyof T & string]: T[N] extends ActivityFunction<any, any> ? N : never;
}[keyof T & string];

/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Extracts argument types of an activity.
 * @template T Activity interface
 * @template N Activity name
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export type ActivityArgs<T, N extends ActivityName<T>> = T[N] extends ActivityFunction<infer P, any> ? P : never;

/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Extracts result type of an activity.
 * @template T Activity interface
 * @template N Activity name
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export type ActivityResult<T, N extends ActivityName<T>> = T[N] extends ActivityFunction<any, infer R> ? R : never;

/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Represents {@link ActivityOptions} with strongly typed arguments.
 * @template Args Types of activity arguments as an array type.
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export type ActivityOptionsWithArgs<Args extends any[]> = Args extends [any, ...any]
  ? Replace<
      ActivityOptions,
      {
        /**
         * Arguments to pass to the Activity
         */
        args: Args | Readonly<Args>;
      }
    >
  : Replace<
      ActivityOptions,
      {
        /**
         * Arguments to pass to the Activity
         */
        args?: Args | Readonly<Args>;
      }
    >;

/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Represents {@link ActivityOptions} with strongly typed arguments matching specified Activity in specified interface.
 * @template T Activity interface
 * @template N Activity name
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export type ActivityOptionsFor<T, N extends ActivityName<T>> = ActivityOptionsWithArgs<ActivityArgs<T, N>>;
