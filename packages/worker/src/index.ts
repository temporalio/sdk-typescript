/**
 * The temporal worker connects to the service and runs workflows and activities.
 *
 * ### Usage
 *
 * <!--SNIPSTART typescript-hello-worker-->
 * <!--SNIPEND-->
 * @module
 */

export {
  ConsoleLogger,
  ForwardLogger,
  Logger as TelemLogger,
  MetricsExporter,
  OtelCollectorExporter,
  PrometheusMetricsExporter,
  TelemetryOptions,
  CustomSlotSupplier,
  SlotInfo,
  WorkflowSlotInfo,
  LocalActivitySlotInfo,
  ActivitySlotInfo,
  SlotMarkUsedContext,
  SlotPermit,
  SlotReleaseContext,
  SlotReserveContext,
} from '@temporalio/core-bridge';
export { NativeConnection } from './connection';
export { NativeConnectionOptions, RequiredNativeConnectionOptions, TLSConfig } from './connection-options';
export { startDebugReplayer } from './debug-replayer';
export { IllegalStateError } from '@temporalio/common';
export {
  ShutdownError,
  TransportError,
  UnexpectedError,
  SlotSupplier,
  ResourceBasedSlotOptions,
  ResourceBasedTunerOptions,
  FixedSizeSlotSupplier,
} from '@temporalio/core-bridge';
export {
  CombinedWorkerRunError,
  CombinedWorkerRunErrorCause,
  GracefulShutdownPeriodExpiredError,
  UnhandledRejectionError,
  PromiseCompletionTimeoutError,
} from './errors';
export * from './interceptors';
export { DefaultLogger, LogEntry, LogLevel, LogMetadata, LogTimestamp, Logger } from './logger';
export { History, Runtime, RuntimeOptions, makeTelemetryFilterString } from './runtime';
export * from './sinks';
export { DataConverter, defaultPayloadConverter, State, Worker, WorkerStatus } from './worker';
export {
  CompiledWorkerOptions,
  ReplayWorkerOptions,
  WorkerOptions,
  WorkflowBundle,
  WorkflowBundleOption,
  WorkflowBundlePath,
} from './worker-options';
export { ReplayError, ReplayHistoriesIterable, ReplayResult } from './replay';
export { BundleOptions, bundleWorkflowCode, WorkflowBundleWithSourceMap } from './workflow/bundler';
export { WorkerTuner } from './worker-tuner';

/* eslint-disable deprecation/deprecation */
// Anything below this line is deprecated

export {
  /**
   * @deprecated `ActivityInboundLogInterceptor` is deprecated. Activity lifecycle events are now automatically logged
   *             by the SDK. To customize activity log attributes, register a custom {@link ActivityOutboundCallsInterceptor}
   *             that intercepts the `getLogAttributes()` method. To customize where log messages are sent,
   *             set the {@link Runtime.logger} property.
   */
  ActivityInboundLogInterceptor,
} from './activity-log-interceptor';

export {
  /**
   * @deprecated This function is meant for internal usage. Don't use it.
   */
  activityLogAttributes,
} from './activity';

export {
  /**
   * @deprecated Including `appendDefaultInterceptors()` in the worker options is no longer required. To configure a
   *             custom logger, set the {@link Runtime.logger} property instead.
   */
  appendDefaultInterceptors,
  /**
   * @deprecated Including `defaultSinks()` in the worker options is no longer required. To configure
   *             a custom logger, set the {@link Runtime.logger} property instead.
   */
  defaultSinks,
  /**
   * @deprecated This no longer contains a source map. Use {@link WorkflowBundlePath} instead.
   */
  WorkflowBundlePathWithSourceMap,
} from './worker-options';

export {
  /**
   * @deprecated Do not use `LoggerSinks` directly. To log from Workflow code, use the `log` object exported by the `@temporalio/workflow`
   *             package. To capture log messages emitted by Workflow code, set the {@link Runtime.logger} property.
   */
  LoggerSinks,
} from '@temporalio/workflow';

export {
  /**
   * @deprecated `WorkflowInboundLogInterceptor` is deprecated. Workflow lifecycle events are now automatically logged
   *             by the SDK. To customize workflow log attributes, simply register a custom `WorkflowInterceptors` that
   *             intercepts the `outbound.getLogAttributes()` method.
   */
  WorkflowInboundLogInterceptor,
  /**
   * @deprecated `WorkflowLogInterceptor` is deprecated. Workflow lifecycle events are now automatically logged
   *             by the SDK. To customize workflow log attributes, simply register a custom `WorkflowInterceptors` that
   *             intercepts the `outbound.getLogAttributes()` method.
   */
  WorkflowLogInterceptor,
} from './workflow-log-interceptor';

export {
  /**
   * @deprecated This function is meant for internal usage. Don't use it.
   */
  workflowLogAttributes,
} from '@temporalio/workflow/lib/logs';

export {
  /**
   * @deprecated This function is meant for internal usage. Don't use it.
   */
  timeOfDayToBigint,
} from './logger';

export {
  /**
   * @deprecated Import error classes directly
   */
  errors,
} from './errors';

/**
 * @deprecated Including `defaultWorkflowInterceptorModules` in BundlerOptions.workflowInterceptorModules is no longer required.
 */
export const defaultWorkflowInterceptorModules = [];
