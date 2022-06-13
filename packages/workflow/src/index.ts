/**
 * This library provides tools required for authoring workflows.
 *
 * ## Usage
 * See the [tutorial](https://docs.temporal.io/typescript/hello-world#workflows) for writing your first workflow.
 *
 * ### Timers
 *
 * The recommended way of scheduling timers is by using the {@link sleep} function.
 * We've replaced `setTimeout` and `clearTimeout` with deterministic versions so these are also usable but have a limitation that they don't play well with [cancellation scopes](https://docs.temporal.io/typescript/workflow-scopes-and-cancellation).
 *
 * <!--SNIPSTART typescript-sleep-workflow-->
 * <!--SNIPEND-->
 *
 * ### Activities
 *
 * To schedule Activities, use {@link proxyActivities} to obtain an Activity function and call.
 *
 * <!--SNIPSTART typescript-schedule-activity-workflow-->
 * <!--SNIPEND-->
 *
 * ### Signals and Queries
 *
 * To add signal handlers to a Workflow, add a signals property to the exported `workflow` object.
 * Signal handlers can return either `void` or `Promise<void>`, you may schedule activities and timers from a signal handler.
 *
 * To add query handlers to a Workflow, add a queries property to the exported `workflow` object.
 * Query handlers must **not** mutate any variables or generate any commands (like Activities or Timers), they run synchronously and thus **must** return a `Promise`.
 *
 * #### Implementation
 *
 * <!--SNIPSTART typescript-workflow-signal-implementation-->
 * <!--SNIPEND-->
 *
 * ### Deterministic built-ins
 * It is safe to call `Math.random()` and `Date()` in workflow code as they are replaced with deterministic versions. We also provide a deterministic {@link uuid4} function for convenience.
 *
 * ### [Cancellation and scopes](https://docs.temporal.io/typescript/workflow-scopes-and-cancellation)
 * - {@link CancellationScope}
 * - {@link Trigger}
 *
 * ### [Sinks](https://docs.temporal.io/typescript/sinks)
 * - {@link Sinks}
 *
 * @module
 */

export {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  defaultPayloadConverter,
  PayloadConverter,
  rootCause,
  ServerFailure,
  TemporalFailure,
  TerminatedFailure,
  TimeoutFailure,
} from '@temporalio/common';
export {
  ActivityCancellationType,
  ActivityFunction,
  ActivityInterface,
  ActivityOptions,
  IllegalStateError,
  RetryPolicy,
  ValueError,
} from '@temporalio/internal-workflow-common';
export * from '@temporalio/internal-workflow-common/lib/interfaces';
export * from '@temporalio/internal-workflow-common/lib/workflow-options';
export { AsyncLocalStorage, CancellationScope, CancellationScopeOptions, ROOT_SCOPE } from './cancellation-scope';
export * from './errors';
export * from './interceptors';
export {
  ChildWorkflowCancellationType,
  ChildWorkflowOptions,
  ContinueAsNew,
  ContinueAsNewOptions,
  ParentClosePolicy,
  ParentWorkflowInfo,
  WorkflowInfo,
} from './interfaces';
export { Sink, SinkCall, SinkFunction, Sinks } from './sinks';
export { Trigger } from './trigger';
export * from './workflow';
export { ChildWorkflowHandle, ExternalWorkflowHandle } from './workflow-handle';
