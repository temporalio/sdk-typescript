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
export {
  /**
   * @deprecated Do not use LoggerSinks directly. To log from Workflow code, use the `log` object
   *             exported by the `@temporalio/workflow` package. To capture log messages emitted
   *             by Workflow code, set the {@see Runtime.logger} property.
   */
  LoggerSinks,
} from '@temporalio/workflow';
export {
  /**
   * @deprecated `ActivityInboundLogInterceptor` is deprecated. To customize activity log attributes,
   *             simply register a custom `WorkflowInterceptors` that intercepts the
   *             `outbound.getLogAttributes()` method. To customize where log messages are sent,
   *             set the {@see Runtime.logger} property.
   */
  ActivityInboundLogInterceptor, // eslint-disable-line deprecation/deprecation
} from './activity-log-interceptor';
export {
  /**
   * @deprecated This function is meant for internal usage. Don't use it.
   */
  activityLogAttributes,
} from './activity';
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
  /**
   * @deprecated Including `appendDefaultInterceptors()` in the worker options is no longer required.
   */
  appendDefaultInterceptors, // eslint-disable-line deprecation/deprecation
  CompiledWorkerOptions,
  /**
   * @deprecated Including `defaultSinks()` in the worker options is no longer required. To configure
   *             a custom logger, set the {@see Runtime.logger} property instead.
   */
  defaultSinks, // eslint-disable-line deprecation/deprecation
  ReplayWorkerOptions,
  WorkerOptions,
  WorkflowBundle,
  WorkflowBundleOption,
  WorkflowBundlePath,
  WorkflowBundlePathWithSourceMap, // eslint-disable-line deprecation/deprecation
} from './worker-options';
export { ReplayError, ReplayHistoriesIterable, ReplayResult } from './replay';
export {
  /**
   * @deprecated `WorkflowInboundLogInterceptor` is deprecated. Workflow life cycle events are now automatically logged
   *             by the SDK. To customize workflow log attributes, simply register a custom `WorkflowInterceptors` that
   *             intercepts the `outbound.getLogAttributes()` method.
   */
  WorkflowInboundLogInterceptor, // eslint-disable-line deprecation/deprecation
  /**
   * @deprecated `WorkflowLogInterceptor` is deprecated. Workflow life cycle events are now automatically logged
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
export { BundleOptions, bundleWorkflowCode, WorkflowBundleWithSourceMap } from './workflow/bundler';
/**
 * @deprecated Including `defaultWorkflowInterceptorModules` in BundlerOptions.workflowInterceptorModules is no longer required.
 */
export const defaultWorkflowInterceptorModules = [];
