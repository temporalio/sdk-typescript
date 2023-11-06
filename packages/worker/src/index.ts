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
export { ActivityInboundLogInterceptor, activityLogAttributes } from './activity-log-interceptor';
export { NativeConnection as NativeConnection } from './connection';
export { NativeConnectionOptions, RequiredNativeConnectionOptions, TLSConfig } from './connection-options';
export { startDebugReplayer } from './debug-replayer';
export { IllegalStateError } from '@temporalio/common';
export { ShutdownError, TransportError, UnexpectedError } from '@temporalio/core-bridge';
export { GracefulShutdownPeriodExpiredError, errors } from './errors'; // eslint-disable-line deprecation/deprecation
export * from './interceptors';
export * from './logger';
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
  appendDefaultInterceptors,
  CompiledWorkerOptions,
  ReplayWorkerOptions,
  WorkerOptions,
  WorkflowBundle,
  WorkflowBundleOption,
  WorkflowBundlePath,
} from './worker-options';
export { ReplayError, ReplayHistoriesIterable, ReplayResult } from './replay';
export {
  WorkflowInboundLogInterceptor, // eslint-disable-line deprecation/deprecation
  WorkflowLogInterceptor,
  workflowLogAttributes,
} from './workflow-log-interceptor';
export {
  BundleOptions,
  bundleWorkflowCode,
  defaultWorkflowInterceptorModules,
  WorkflowBundleWithSourceMap,
} from './workflow/bundler';

// Anything below this line is deprecated

export {
  /**
   * @deprecated Including `defaultSinks()` in the worker options is no longer required. To configure
   *             a custom logger, set the {@see Runtime.logger} property instead.
   */
  defaultSinks, // eslint-disable-line deprecation/deprecation
  /**
   * @deprecated This no longer contains a source map. Use {@see WorkflowBundlePath} instead.
   */
  WorkflowBundlePathWithSourceMap, // eslint-disable-line deprecation/deprecation
} from './worker-options';
export {
  /**
   * @deprecated Do not use `LoggerSinks` directly. To log from Workflow code, use the `log` object exported by the `@temporalio/workflow`
   *             package. To capture log messages emitted by Workflow code, set the {@see Runtime.logger} property.
   */
  LoggerSinks,
} from '@temporalio/workflow';
