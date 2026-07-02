import { PayloadTypeHints } from './type-hints';
import type { VersioningBehavior } from './worker-deployments';

/** NEEDS REAL DOCSTRINGS */
export interface WorkflowDefinitionConfig {
  // Options that can be set per workflow execution
  // THOMAS - i'd like to rename this to instanceOptions
  workflowDefinitionOptions?: WorkflowDefinitionOptionsOrGetter;
  // Options that are set once at workflow definition (static)
  staticOptions?: WorkflowStaticOptions;
}

/**
 * Options that can be used when defining a workflow via {@link setWorkflowOptions}.
 */
export interface WorkflowDefinitionOptions {
  versioningBehavior?: VersioningBehavior;

  /**
   * The types of errors that, if thrown by the Workflow function, a signal handler, or an update
   * handler, will cause the Workflow Execution or the Update to fail instead of failing the
   * Workflow Task (which would result in retrying the Workflow Task until it eventually succeeds).
   *
   * This is a per-Workflow-type equivalent of {@link WorkerOptions.workflowFailureErrorTypes}.
   * Both settings are evaluated; an error matching either will cause Workflow failure.
   * Unlike the string-based {@link WorkerOptions.workflowFailureErrorTypes}, this accepts
   * actual class references, enabling subclass matching via `instanceof`, but doesn't allow
   * failing the workflow execution on _non-determinism errors_. Failing the workflow execution on
   * non-determinism errors can only be set via {@link WorkerOptions.workflowFailureErrorTypes}.
   *
   * Passing the `Error` class to this setting will fail the Workflow on any error, except
   * non-determinism errors.
   *
   * Note that {@link TemporalFailure} subclasses and cancellation errors that bubbles out
   * of the Workflow always fail the Workflow Execution, regardless of either this and the
   * {@link WorkerOptions.workflowFailureErrorTypes} settings.
   *
   * @experimental
   */
  failureExceptionTypes?: Array<new (...args: any[]) => Error>;
}

export interface WorkflowStaticOptions {
  /**
   * Type hints! For workflow input/output.
   *
   * Validated at compile-time (can we do this?)
   *
   * @experimental
   */
  typeHints?: PayloadTypeHints;
}

type AsyncFunction<Args extends any[], ReturnType> = (...args: Args) => Promise<ReturnType>;
export type WorkflowDefinitionOptionsOrGetter = WorkflowDefinitionOptions | (() => WorkflowDefinitionOptions);

/**
 * @internal
 * @hidden
 * A workflow function that has been defined with options from {@link WorkflowDefinitionOptions}.
 */
export type WorkflowFunctionWithOptions<Args extends any[], ReturnType> = AsyncFunction<Args, ReturnType> &
  Required<Pick<WorkflowDefinitionConfig, 'workflowDefinitionOptions'>>;

/** @internal */
export type WorkflowFunctionWithStaticOptions<Args extends any[], ReturnType> = AsyncFunction<Args, ReturnType> &
  Required<Pick<WorkflowDefinitionConfig, 'staticOptions'>>;

const workflowDefinitionOptionsProperty = 'workflowDefinitionOptions' satisfies keyof WorkflowFunctionWithOptions<
  any[],
  any
>;
const workflowStaticOptionsProperty = 'staticOptions' satisfies keyof WorkflowFunctionWithStaticOptions<any[], any>;

/** @internal */
export function isWorkflowFunctionWithOptions(obj: unknown): obj is WorkflowFunctionWithOptions<any[], any> {
  return typeof obj === 'function' && Object.hasOwn(obj, workflowDefinitionOptionsProperty);
}

/** @internal */
export function isWorkflowFunctionWithStaticOptions(
  obj: unknown
): obj is WorkflowFunctionWithStaticOptions<any[], any> {
  return typeof obj === 'function' && Object.hasOwn(obj, workflowStaticOptionsProperty);
}
