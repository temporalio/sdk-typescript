import type { VersioningBehavior } from './worker-deployments';

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
