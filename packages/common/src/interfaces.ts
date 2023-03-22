import type { temporal } from '@temporalio/proto';

export type Payload = temporal.api.common.v1.IPayload;

/** Type that can be returned from a Workflow `execute` function */
export type WorkflowReturnType = Promise<any>;
export type WorkflowSignalType = (...args: any[]) => Promise<void> | void;
export type WorkflowQueryType = (...args: any[]) => any;

/**
 * Broad Workflow function definition, specific Workflows will typically use a narrower type definition, e.g:
 * ```ts
 * export async function myWorkflow(arg1: number, arg2: string): Promise<string>;
 * ```
 */
export type Workflow = (...args: any[]) => WorkflowReturnType;

declare const argsBrand: unique symbol;
/**
 * An interface representing a Workflow signal definition, as returned from {@link defineSignal}
 *
 * @remarks `Args` can be used for parameter type inference in handler functions and *WorkflowHandle methods.
 * `Name` can optionally be specified with a string literal type to preserve type-level knowledge of the signal name.
 */
export interface SignalDefinition<Args extends any[] = [], Name extends string = string> {
  type: 'signal';
  name: Name;
  /**
   * Virtual type brand to maintain a distinction between {@link SignalDefinition} types with different args.
   * This field is not present at run-time.
   */
  [argsBrand]: Args;
}

declare const retBrand: unique symbol;
/**
 * An interface representing a Workflow query definition as returned from {@link defineQuery}
 *
 * @remarks `Args` and `Ret` can be used for parameter type inference in handler functions and *WorkflowHandle methods.
 * `Name` can optionally be specified with a string literal type to preserve type-level knowledge of the query name.
 */
export interface QueryDefinition<Ret, Args extends any[] = [], Name extends string = string> {
  type: 'query';
  name: Name;
  /**
   * Virtual type brand to maintain a distinction between {@link QueryDefinition} types with different args.
   * This field is not present at run-time.
   */
  [argsBrand]: Args;
  /**
   * Virtual type brand to maintain a distinction between {@link QueryDefinition} types with different return types.
   * This field is not present at run-time.
   */
  [retBrand]: Ret;
}

/** Get the "unwrapped" return type (without Promise) of the execute handler from Workflow type `W` */
export type WorkflowResultType<W extends Workflow> = ReturnType<W> extends Promise<infer R> ? R : never;

/**
 * If another SDK creates a Search Attribute that's not an array, we wrap it in an array.
 *
 * Dates are serialized as ISO strings.
 */
export type SearchAttributes = Record<string, SearchAttributeValue | Readonly<SearchAttributeValue> | undefined>;
export type SearchAttributeValue = string[] | number[] | boolean[] | Date[];

export interface ActivityFunction<P extends any[] = any[], R = any> {
  (...args: P): Promise<R>;
}

/**
 * Mapping of Activity name to function
 * @deprecated not required anymore, for untyped activities use {@link UntypedActivities}
 */
export type ActivityInterface = Record<string, ActivityFunction>;

/**
 * Mapping of Activity name to function
 */
export type UntypedActivities = Record<string, ActivityFunction>;

/**
 * A workflow's history and ID. Useful for replay.
 */
export interface HistoryAndWorkflowId {
  workflowId: string;
  history: temporal.api.history.v1.History | unknown | undefined;
}
