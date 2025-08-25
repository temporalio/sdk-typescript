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
 * ### Updates, Signals and Queries
 *
 * Use {@link setHandler} to set handlers for Updates, Signals, and Queries.
 *
 * Update and Signal handlers can be either async or non-async functions. Update handlers may return a value, but signal
 * handlers may not (return `void` or `Promise<void>`). You may use Activities, Timers, child Workflows, etc in Update
 * and Signal handlers, but this should be done cautiously: for example, note that if you await async operations such as
 * these in an Update or Signal handler, then you are responsible for ensuring that the workflow does not complete first.
 *
 * Query handlers may **not** be async functions, and may **not** mutate any variables or use Activities, Timers,
 * child Workflows, etc.
 *
 * #### Implementation
 *
 * <!--SNIPSTART typescript-workflow-update-signal-query-example-->
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
  SearchAttributes, // eslint-disable-line deprecation/deprecation
  SearchAttributeValue, // eslint-disable-line deprecation/deprecation
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
  StackTraceFileLocation,
  StackTraceFileSlice,
  ParentClosePolicy,
  ParentWorkflowInfo,
  RootWorkflowInfo,
  StackTraceSDKInfo,
  StackTrace,
  UnsafeWorkflowInfo,
  WorkflowInfo,
} from './interfaces';
export { proxySinks, Sink, SinkCall, SinkFunction, Sinks } from './sinks';
export { log } from './logs';
export { Trigger } from './trigger';
export * from './workflow';
export { ChildWorkflowHandle, ExternalWorkflowHandle } from './workflow-handle';
export { metricMeter } from './metrics';

export { createNexusClient, NexusClientOptions, NexusClient, NexusOperationHandle } from './nexus';

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Deprecated APIs
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export {
  /**
   * @deprecated Do not use LoggerSinks directly. To log from Workflow code, use the `log` object
   *             exported by the `@temporalio/workflow` package. To capture log messages emitted
   *             by Workflow code, set the {@link Runtime.logger} property.
   */
  // eslint-disable-next-line deprecation/deprecation
  LoggerSinksDeprecated as LoggerSinks,
} from './logs';
