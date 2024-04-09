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
} from '@temporalio/core-bridge';
export { NativeConnection } from './connection';
export { NativeConnectionOptions, RequiredNativeConnectionOptions, TLSConfig } from './connection-options';
export { startDebugReplayer } from './debug-replayer';
export { IllegalStateError } from '@temporalio/common';
export { ShutdownError, TransportError, UnexpectedError } from '@temporalio/core-bridge';
export { GracefulShutdownPeriodExpiredError, errors } from './errors'; // eslint-disable-line deprecation/deprecation
export * from './interceptors';
export { DefaultLogger, LogEntry, LogLevel, LogMetadata, LogTimestamp, Logger, withMetadata } from './logger';
export { History, Runtime, RuntimeOptions, makeTelemetryFilterString } from './runtime';
export * from './sinks';
export {
  CombinedWorkerRunError,
  CombinedWorkerRunErrorCause,
  DataConverter,
  defaultPayloadConverter,
  State,
  Worker,
  WorkerStatus,
} from './worker';
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

// Anything below this line is deprecated

export {
  /**
   * @deprecated `ActivityInboundLogInterceptor` is deprecated. Activity lifecycle events are now automatically logged
   *             by the SDK. To customize activity log attributes, register a custom {@link ActivityOutboundCallsInterceptor}
   *             that intercepts the `getLogAttributes()` method. To customize where log messages are sent,
   *             set the {@link Runtime.logger} property.
   */
  ActivityInboundLogInterceptor, // eslint-disable-line deprecation/deprecation
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
  appendDefaultInterceptors, // eslint-disable-line deprecation/deprecation
  /**
   * @deprecated Including `defaultSinks()` in the worker options is no longer required. To configure
   *             a custom logger, set the {@link Runtime.logger} property instead.
   */
  defaultSinks, // eslint-disable-line deprecation/deprecation
  /**
   * @deprecated This no longer contains a source map. Use {@link WorkflowBundlePath} instead.
   */
  WorkflowBundlePathWithSourceMap, // eslint-disable-line deprecation/deprecation
} from './worker-options';
export {
  /**
   * @deprecated Do not use `LoggerSinks` directly. To log from Workflow code, use the `log` object exported by the `@temporalio/workflow`
   *             package. To capture log messages emitted by Workflow code, set the {@link Runtime.logger} property.
   */
  LoggerSinks, // eslint-disable-line deprecation/deprecation
} from '@temporalio/workflow';
export {
  /**
   * @deprecated `WorkflowInboundLogInterceptor` is deprecated. Workflow lifecycle events are now automatically logged
   *             by the SDK. To customize workflow log attributes, simply register a custom `WorkflowInterceptors` that
   *             intercepts the `outbound.getLogAttributes()` method.
   */
  WorkflowInboundLogInterceptor, // eslint-disable-line deprecation/deprecation
  /**
   * @deprecated `WorkflowLogInterceptor` is deprecated. Workflow lifecycle events are now automatically logged
   *             by the SDK. To customize workflow log attributes, simply register a custom `WorkflowInterceptors` that
   *             intercepts the `outbound.getLogAttributes()` method.
   */
  WorkflowLogInterceptor, // eslint-disable-line deprecation/deprecation
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
/**
 * @deprecated Including `defaultWorkflowInterceptorModules` in BundlerOptions.workflowInterceptorModules is no longer required.
 */
export const defaultWorkflowInterceptorModules = [];
