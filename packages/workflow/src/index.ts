/**
 * This library provides tools required for authoring workflows.
 *
 * ## Usage
 * See the {@link https://docs.temporal.io/typescript/hello-world#workflows | tutorial} for writing your first workflow.
 *
 * ### Timers
 *
 * The recommended way of scheduling timers is by using the {@link sleep} function. We've replaced `setTimeout` and
 * `clearTimeout` with deterministic versions so these are also usable but have a limitation that they don't play well
 * with {@link https://docs.temporal.io/typescript/cancellation-scopes | cancellation scopes}.
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
 * To add signal handlers to a Workflow, add a signals property to the exported `workflow` object. Signal handlers can
 * return either `void` or `Promise<void>`, you may schedule activities and timers from a signal handler.
 *
 * To add query handlers to a Workflow, add a queries property to the exported `workflow` object. Query handlers must
 * **not** mutate any variables or generate any commands (like Activities or Timers), they run synchronously and thus
 * **must** return a `Promise`.
 *
 * #### Implementation
 *
 * <!--SNIPSTART typescript-workflow-signal-implementation-->
 * <!--SNIPEND-->
 *
 * ### More
 *
 * - [Deterministic built-ins](https://docs.temporal.io/typescript/determinism#sources-of-non-determinism)
 * - [Cancellation and scopes](https://docs.temporal.io/typescript/cancellation-scopes)
 *   - {@link CancellationScope}
 *   - {@link Trigger}
 * - [Sinks](https://docs.temporal.io/application-development/observability/?lang=ts#logging)
 *   - {@link Sinks}
 *
 * @module
 */

export {
  ActivityCancellationType,
  ActivityFailure,
  ActivityOptions,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  defaultPayloadConverter,
  PayloadConverter,
  RetryPolicy,
  rootCause,
  ServerFailure,
  TemporalFailure,
  TerminatedFailure,
  TimeoutFailure,
} from '@temporalio/common';
export * from '@temporalio/common/lib/errors';
export {
  ActivityFunction,
  ActivityInterface, // eslint-disable-line deprecation/deprecation
  Payload,
  QueryDefinition,
  SearchAttributes,
  SearchAttributeValue,
  SignalDefinition,
  UntypedActivities,
  Workflow,
  WorkflowQueryType,
  WorkflowResultType,
  WorkflowReturnType,
  WorkflowSignalType,
} from '@temporalio/common/lib/interfaces';
export * from '@temporalio/common/lib/workflow-handle';
export * from '@temporalio/common/lib/workflow-options';
export { AsyncLocalStorage, CancellationScope, CancellationScopeOptions } from './cancellation-scope';
export * from './errors';
export * from './interceptors';
export {
  ChildWorkflowCancellationType,
  ChildWorkflowOptions,
  ContinueAsNew,
  ContinueAsNewOptions,
  EnhancedStackTrace,
  FileLocation,
  FileSlice,
  ParentClosePolicy,
  ParentWorkflowInfo,
  SDKInfo,
  StackTrace,
  UnsafeWorkflowInfo,
  WorkflowInfo,
} from './interfaces';
export { LoggerSinks, Sink, SinkCall, SinkFunction, Sinks } from './sinks';
export { Trigger } from './trigger';
export * from './workflow';
export { ChildWorkflowHandle, ExternalWorkflowHandle } from './workflow-handle';
