import type { PayloadTypeInfo } from './type-info';
import type { VersioningBehavior } from './worker-deployments';

/**
 * Options that can be attached to a Workflow function at definition time.
 *
 * @experimental
 */
export interface WorkflowDefinitionConfig {
  /** Options that may be evaluated for each Workflow Execution. */
  workflowDefinitionOptions?: WorkflowDefinitionOptionsOrGetter;
  /** Static metadata that must be available before Workflow input decoding. */
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
   * Type information used to encode and decode Workflow input and output.
   *
   * @experimental
   */
  typeInfo?: PayloadTypeInfo;
}

type AsyncFunction<Args extends any[], ReturnType> = (...args: Args) => Promise<ReturnType>;
export type WorkflowDefinitionOptionsOrGetter = WorkflowDefinitionOptions | (() => WorkflowDefinitionOptions);

/**
 * @internal
 * @hidden
 * A workflow function that has been defined with options from {@link WorkflowDefinitionOptions}.
 */
export interface WorkflowFunctionWithOptions<Args extends any[], ReturnType> extends AsyncFunction<Args, ReturnType> {
  workflowDefinitionOptions: WorkflowDefinitionOptionsOrGetter;
}

/** @internal */
export interface WorkflowFunctionWithStaticOptions<Args extends any[], ReturnType>
  extends AsyncFunction<Args, ReturnType> {
  staticOptions: WorkflowStaticOptions;
}

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
  if (typeof obj !== 'function' || !Object.hasOwn(obj, workflowStaticOptionsProperty)) {
    return false;
  }
  const { staticOptions } = obj as { staticOptions?: unknown };
  return typeof staticOptions === 'object' && staticOptions !== null;
}
