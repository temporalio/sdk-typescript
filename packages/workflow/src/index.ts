/**
 * This library provides tools required for authoring workflows.
 *
 * ## Usage
 * See the [tutorial](https://docs.temporal.io/docs/node/hello-world#workflows) for writing your first workflow.
 *
 * ### Timers
 *
 * The recommended way of scheduling timers is by using the {@link sleep} function.
 * We've replaced `setTimeout` and `clearTimeout` with deterministic versions so these are also usable but have a limitation that they don't play well with [cancellation scopes](https://docs.temporal.io/docs/node/workflow-scopes-and-cancellation).
 *
 * <!--SNIPSTART nodejs-sleep-workflow-->
 * <!--SNIPEND-->
 *
 * ### Activities
 *
 * To schedule activities in the system, simply import an activity function from any registered activity file and call it like a normal function, the Temporal workflow runtime will replace the imported function with a stub which will schedules an activity.
 *
 * Activities run with the worker's configured {@link WorkerOptions.activityDefaults | activityDefaults}, use {@link ContextImpl.configure | Context.configure} in order to customize the {@link ActivityOptions | activity options}.
 *
 * <!--SNIPSTART nodejs-schedule-activity-workflow-->
 * <!--SNIPEND-->
 *
 * ### Signals
 *
 * To add signal handlers to a workflow, add a signals property to the exported workflow object.
 * Signal handlers can return either `void` or `Promise<void>`, you may schedule activities and timers from a signal handler.
 *
 * #### Interface
 * <!--SNIPSTART nodejs-workflow-signal-interface-->
 * <!--SNIPEND-->
 *
 * #### Implementation
 * <!--SNIPSTART nodejs-workflow-signal-implementation-->
 * <!--SNIPEND-->
 *
 * ### Deterministic built-ins
 * It is safe to call `Math.random()` and `Date()` in workflow code as they are replaced with deterministic versions. We also provide a deterministic {@link uuid4} function for convenience.
 *
 * ### [Cancellation and scopes](https://docs.temporal.io/docs/node/workflow-scopes-and-cancellation)
 * - {@link CancellationScope}
 * - {@link Trigger}
 *
 * ### [External dependencies](https://docs.temporal.io/docs/node/workflow-external-dependencies)
 * - {@link ExternalDependencies}
 * - {@link ApplyMode}
 *
 * @module
 */

import './global-overrides';

export {
  ActivityFunction,
  ActivityOptions,
  ApplyMode,
  ExternalDependencyFunction,
  ExternalDependency,
  ExternalDependencies,
  LocalActivityOptions,
  RemoteActivityOptions,
  RetryOptions,
  Workflow,
  WorkflowInfo,
} from './interfaces';
export { CancellationError, DeterminismViolationError, IllegalStateError } from './errors';
export { Context, ContextImpl, sleep, uuid4, validateActivityOptions, scheduleActivity } from './workflow';
export * from './interceptors';
export { CancellationScope, CancellationScopeOptions } from './cancellation-scope';
export { Trigger } from './trigger';
export { defaultDataConverter, DataConverter } from './converter/data-converter';
