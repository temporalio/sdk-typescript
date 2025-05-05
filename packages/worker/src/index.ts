/**
 * The temporal worker connects to the service and runs workflows and activities.
 *
 * ### Usage
 *
 * <!--SNIPSTART typescript-hello-worker-->
 * <!--SNIPEND-->
 * @module
 */

export { NativeConnection } from './connection';
export { NativeConnectionOptions, TLSConfig } from './connection-options';
export { startDebugReplayer } from './debug-replayer';
export { IllegalStateError } from '@temporalio/common';
export {
  CombinedWorkerRunError,
  CombinedWorkerRunErrorCause,
  GracefulShutdownPeriodExpiredError,
  PromiseCompletionTimeoutError,
  UnhandledRejectionError,
} from './errors';
export * from './interceptors';
export { DefaultLogger, LogEntry, LogLevel, LogMetadata, LogTimestamp, Logger } from './logger';
export { History, Runtime } from './runtime';
export {
  RuntimeOptions,
  makeTelemetryFilterString,
  ConsoleLogger,
  ForwardLogger,
  LogExporterConfig,
  MetricsExporterConfig,
  OtelCollectorExporter,
  PrometheusMetricsExporter,
  TelemetryOptions,
} from './runtime-options';
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
export {
  WorkerTuner,
  TunerHolder,
  SlotSupplier,
  ResourceBasedTuner,
  ResourceBasedTunerOptions,
  ResourceBasedSlotOptions,
  ResourceBasedSlotsForType,
  FixedSizeSlotSupplier,
  CustomSlotSupplier,
  SlotInfo,
  WorkflowSlotInfo,
  ActivitySlotInfo,
  LocalActivitySlotInfo,
  SlotPermit,
  SlotReserveContext,
  SlotMarkUsedContext,
  SlotReleaseContext,
} from './worker-tuner';

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
   * @deprecated Import error classes directly
   */
  errors,
  /**
   * @deprecated - meant for internal use only
   * @hidden
   */
  ShutdownError,
  /**
   * @deprecated - meant for internal use only
   * @hidden
   */
  TransportError,
  /**
   * @deprecated - meant for internal use only
   * @hidden
   */
  UnexpectedError,
} from './errors';

/**
 * @deprecated Including `defaultWorkflowInterceptorModules` in BundlerOptions.workflowInterceptorModules is no longer required.
 */
export const defaultWorkflowInterceptorModules = [];

export {
  /**
   * @deprecated Use {@link MetricsExporterConfig} instead.
   */
  MetricsExporterConfig as MetricsExporter,
} from './runtime-options';
