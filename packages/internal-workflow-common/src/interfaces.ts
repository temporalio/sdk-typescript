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

/**
 * An interface representing a Workflow signal definition, as returned from {@link defineSignal}
 *
 * @remarks `_Args` can be used for parameter type inference in handler functions and *WorkflowHandle methods.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface SignalDefinition<_Args extends any[] = []> {
  type: 'signal';
  name: string;
}

/**
 * An interface representing a Workflow query definition as returned from {@link defineQuery}
 *
 * @remarks `_Args` and `_Ret` can be used for parameter type inference in handler functions and *WorkflowHandle methods.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface QueryDefinition<_Ret, _Args extends any[] = []> {
  type: 'query';
  name: string;
}

/** Get the "unwrapped" return type (without Promise) of the execute handler from Workflow type `W` */
export type WorkflowResultType<W extends Workflow> = ReturnType<W> extends Promise<infer R> ? R : never;

/**
 * If another SDK creates a Search Attribute that's not an array, we wrap it in an array.
 *
 * Dates are serialized as ISO strings.
 */
export type SearchAttributes = Record<string, SearchAttributeValue>;
export type SearchAttributeValue = string[] | number[] | boolean[] | Date[];
