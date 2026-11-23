import type { ActivityFunction, PayloadTypeInfo } from '@temporalio/common';
import type { ActivityOptions, LocalActivityOptions } from './activities';
import { activityReferenceName } from './activity-reference';
import { scheduleActivity, scheduleLocalActivity } from './workflow';

type ActivityArguments<A extends ActivityFunction> =
  [] extends Parameters<A>
    ? { args?: Parameters<A> | Readonly<Parameters<A>> }
    : { args: Parameters<A> | Readonly<Parameters<A>> };

/**
 * Options for {@link executeActivity}. At least one of `startToCloseTimeout` and
 * `scheduleToCloseTimeout` must be specified.
 *
 * @experimental
 */
export type ExecuteActivityOptions<A extends ActivityFunction = ActivityFunction> = ActivityOptions &
  ActivityArguments<A> & {
    /** Explicit serialization metadata. Metadata attached to the implementation is not imported. */
    typeInfo?: PayloadTypeInfo;
  };

/** Options for {@link executeLocalActivity}. @experimental */
export type ExecuteLocalActivityOptions<A extends ActivityFunction = ActivityFunction> = LocalActivityOptions &
  ActivityArguments<A> & {
    /** Explicit serialization metadata. Metadata attached to the implementation is not imported. */
    typeInfo?: PayloadTypeInfo;
  };

/**
 * Execute an Activity using the same scheduling, cancellation, and retry behavior as {@link proxyActivities}.
 *
 * In TypeScript workflow source, named imports passed directly to this function are
 * replaced with Activity references without loading their implementation modules.
 * All runtime uses of an inferred reference must be direct calls to one of the two
 * execution APIs. Other specifiers in the same import retain normal import behavior.
 * For references passed through wrappers or factories, mark the import explicitly:
 *
 * ```ts
 * import { echo } from './activities' with { temporal: 'activity' };
 * import { executeActivity } from '@temporalio/workflow';
 *
 * await executeActivity(echo, { args: ['hello'], startToCloseTimeout: '1m' });
 * ```
 *
 * Explicit import attributes require TypeScript 5.3+ and a compatible module configuration.
 * Marked imports do not run the imported module's initialization or side effects.
 * References retain the imported function's type, but cannot be called directly.
 * The Activity name is its imported export name, not a local alias or function name.
 * Register the implementation under that name on an Activity Worker.
 *
 * Alternatively pass a registered Activity name, optionally with an explicit Activity
 * function type parameter. Name-based calls do not require a source transform.
 *
 * @experimental
 */
export function executeActivity<A extends ActivityFunction>(
  activity: A,
  options: ExecuteActivityOptions<NoInfer<A>>
): Promise<Awaited<ReturnType<A>>>;
export function executeActivity<A extends ActivityFunction = ActivityFunction>(
  activity: string,
  options: ExecuteActivityOptions<A>
): Promise<Awaited<ReturnType<A>>>;
export function executeActivity(
  activity: ActivityFunction | string,
  options: ExecuteActivityOptions
): Promise<unknown> {
  const name = activityReferenceName(activity, 'executeActivity');
  const { args = [], typeInfo, ...activityOptions } = options;
  return scheduleActivity(name, [...args], activityOptions, typeInfo);
}

/**
 * Execute a Local Activity using the same scheduling, cancellation, and retry behavior
 * as {@link proxyLocalActivities}. Import transformation and reference naming follow
 * {@link executeActivity}.
 *
 * @experimental
 */
export function executeLocalActivity<A extends ActivityFunction>(
  activity: A,
  options: ExecuteLocalActivityOptions<NoInfer<A>>
): Promise<Awaited<ReturnType<A>>>;
export function executeLocalActivity<A extends ActivityFunction = ActivityFunction>(
  activity: string,
  options: ExecuteLocalActivityOptions<A>
): Promise<Awaited<ReturnType<A>>>;
export function executeLocalActivity(
  activity: ActivityFunction | string,
  options: ExecuteLocalActivityOptions
): Promise<unknown> {
  const name = activityReferenceName(activity, 'executeLocalActivity');
  const { args = [], typeInfo, ...activityOptions } = options;
  return scheduleLocalActivity(name, [...args], activityOptions, typeInfo);
}
