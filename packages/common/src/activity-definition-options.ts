import type { ActivityFunction } from './interfaces';
import type { PayloadTypeInfo } from './type-info';

/**
 * Static metadata attached to an Activity function.
 *
 * @experimental
 */
export interface ActivityDefinitionOptions {
  /** Type information used to decode Activity arguments and encode its result. */
  typeInfo?: PayloadTypeInfo;
}

type ActivityKeys<A> = {
  [K in keyof A & string]: A[K] extends ActivityFunction ? K : never;
}[keyof A & string];

/**
 * Type information keyed only by Activity-valued properties of `A`.
 *
 * @experimental
 */
export type ActivityTypeInfoMap<A> = Partial<Record<ActivityKeys<A>, PayloadTypeInfo>>;

/** @internal */
export interface ActivityFunctionWithOptions<Args extends any[] = any[], ReturnType = any>
  extends ActivityFunction<Args, ReturnType> {
  activityDefinitionOptions: ActivityDefinitionOptions;
}

const activityDefinitionOptionsProperty = 'activityDefinitionOptions' satisfies keyof ActivityFunctionWithOptions;

/** @internal */
export function isActivityFunctionWithOptions(value: unknown): value is ActivityFunctionWithOptions<any[], any> {
  if (typeof value !== 'function' || !Object.hasOwn(value, activityDefinitionOptionsProperty)) {
    return false;
  }
  const { activityDefinitionOptions } = value as { activityDefinitionOptions?: unknown };
  return typeof activityDefinitionOptions === 'object' && activityDefinitionOptions !== null;
}
