import { SpanContext } from '@opentelemetry/api';
import type { TLSConfig } from '@temporalio/common/lib/internal-non-workflow';

export { TLSConfig };

type Shadow<Base, New> = Base extends object
  ? New extends object
    ? {
        [K in keyof Base | keyof New]: K extends keyof Base
          ? K extends keyof New
            ? Shadow<Base[K], New[K]>
            : Base[K]
          : K extends keyof New
          ? New[K]
          : never;
      }
    : New
  : New;

export interface RetryOptions {
  /** Initial wait time before the first retry. */
  initialInterval: number;
  /**
   * Randomization jitter that is used as a multiplier for the current retry interval
   * and is added or subtracted from the interval length.
   */
  randomizationFactor: number;
  /** Rate at which retry time should be increased, until it reaches max_interval. */
  multiplier: number;
  /** Maximum amount of time to wait between retries. */
  maxInterval: number;
  /** Maximum total amount of time requests should be retried for, if None is set then no limit will be used. */
  maxElapsedTime?: number;
  /** Maximum number of retry attempts. */
  maxRetries: number;
}

export interface ClientOptions {
  /**
   * The URL of the Temporal server to connect to
   */
  url: string;

  /** Version string for the whole node SDK. Should never be set by user */
  sdkVersion: string;

  /**
   * TLS configuration options.
   *
   * Pass undefined to use a non-encrypted connection or an empty object to
   * connect with TLS without any customization.
   */
  tls?: TLSConfig;

  /**
   * Optional retry options for server requests.
   */
  retry?: RetryOptions;

  /**
   * Optional mapping of gRPC metadata (HTTP headers) to send with each request to the server.
   *
   * Set statically at connection time, can be replaced later using {@link clientUpdateHeaders}.
   */
  metadata?: Record<string, string>;
}

/**
 * Log directly to console
 *
 * @experimental
 */
export interface ConsoleLogger {
  console: {}; // eslint-disable-line @typescript-eslint/ban-types
}

/**
 * Forward logs to {@link Runtime} logger
 *
 * @experimental
 */
export interface ForwardLogger {
  forward: {
    /**
     * What level, if any, logs should be forwarded from core at
     *
     * @deprecated Use {@link TelemetryOptions.logging.filter} instead
     */
    level?: LogLevel;
  };
}

/**
 * Logger types supported by Core
 *
 * @experimental
 */
export type Logger = ConsoleLogger | ForwardLogger;

/**
 * OpenTelemetry Collector options for exporting metrics or traces
 *
 * @experimental
 */
export interface OtelCollectorExporter {
  otel: {
    /**
     * URL of a gRPC OpenTelemetry collector.
     */
    url: string;
    /**
     * Optional set of HTTP request headers to send to Collector (e.g. for authentication)
     */
    headers?: Record<string, string>;
    /**
     * Specify how frequently in metrics should be exported.
     *
     * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
     * @defaults 1 second
     */
    metricsExportInterval?: string | number;
  };
}

/** @experimental */
export type CompiledOtelTraceExporter = Shadow<OtelCollectorExporter, { otel: { metricsExportInterval?: never } }>;

/** @experimental */
export type CompiledOtelMetricsExporter = Shadow<OtelCollectorExporter, { otel: { metricsExportInterval: number } }>;

/**
 * Prometheus metrics exporter options
 *
 * @experimental
 */
export interface PrometheusMetricsExporter {
  prometheus: {
    /**
     * Address to bind the Prometheus HTTP metrics exporter server
     * (for example, `0.0.0.0:1234`).
     *
     * Metrics will be available for scraping under the standard `/metrics` route.
     */
    bindAddress: string;
  };
}

/**
 * Metrics exporters supported by Core
 *
 * `temporality` is the type of aggregation temporality for metric export. Applies to both Prometheus and OpenTelemetry exporters.
 *
 * See the [OpenTelemetry specification](https://github.com/open-telemetry/opentelemetry-specification/blob/ce50e4634efcba8da445cc23523243cb893905cb/specification/metrics/datamodel.md#temporality) for more information.
 *
 * @experimental
 */
export type MetricsExporter = {
  temporality?: 'cumulative' | 'delta';
} & (PrometheusMetricsExporter | OtelCollectorExporter);

/**
 * Trace exporters supported by Core
 *
 * @experimental
 */
export type TraceExporter = OtelCollectorExporter;

/** @experimental */
export interface TelemetryOptions {
  /**
   * A string in the env filter format specified here:
   * https://docs.rs/tracing-subscriber/0.2.20/tracing_subscriber/struct.EnvFilter.html
   *
   * Which determines what tracing data is collected in the Core SDK.
   *
   * @deprecated Use either `logging.filter` or `tracing.filter` instead
   */
  tracingFilter?: string;

  /**
   * If set true, do not prefix metrics with `temporal_`. Will be removed eventually as
   * the prefix is consistent with other SDKs.
   *
   * @default `false`
   */
  noTemporalPrefixForMetrics?: boolean;

  /**
   * Control where to send Rust Core logs
   */
  logging?: {
    /**
     * A string in (env filter format)[https://docs.rs/tracing-subscriber/0.2.20/tracing_subscriber/struct.EnvFilter.html]
     * which determines the verboseness of logging output.
     *
     * You can use {@link Runtime.makeTelemetryFilterString()} to easily build a correctly formatted filter
     * string based on desired log level for Core SDK and other native packages.
     *
     * **BACKWARD COMPATIBILITY**
     *
     * If `logging.filter` is missing, the following legacy values (if present) will be used instead (in the given order):
     * - {@link ForwardLogger.forward.level} => `makeTelemetryFilterString({ core: level, other: level })`
     * - {@link TelemetryOptions.tracingFilter}
     * - Default value of `makeTelemetryFilterString({ core: 'INFO', other: 'INFO'})`
     *
     * @default `makeTelemetryFilterString({ core: 'INFO', other: 'INFO'})` (with some exceptions, as described in backward compatibility note above)
     */
    filter?: string;
  } & Partial<Logger>;

  /**
   * Control where to send traces generated by Rust Core, optional and turned off by default.
   *
   * This is typically used for profiling SDK internals.
   */
  tracing?: {
    /**
     * A string in (env filter format)[https://docs.rs/tracing-subscriber/0.2.20/tracing_subscriber/struct.EnvFilter.html]
     * which determines what tracing data is collected in the Core SDK.
     *
     * You can use {@link Runtime.makeTelemetryFilterString()} to easily build a correctly formatted filter
     * string based on desired log level for Core SDK and other native packages.
     *
     * **BACKWARD COMPATIBILITY**
     *
     * If `tracing.filter` is missing, the following legacy values (if present) will be used instead (in the given order):
     * - {@link TelemetryOptions.tracingFilter}
     * - Default value of `makeTelemetryFilterString({ core: 'INFO', other: 'INFO'})`
     *
     * @default `makeTelemetryFilterString({ core: 'INFO', other: 'INFO'})` (with some exceptions, as described in backward compatibility note above)
     */
    filter?: string;
  } & Partial<TraceExporter>;

  /**
   * Control exporting {@link NativeConnection} and {@link Worker} metrics.
   *
   * Turned off by default
   */
  metrics?: MetricsExporter;
}

/** @experimental */
export type CompiledTelemetryOptions = {
  noTemporalPrefixForMetrics?: boolean;
  logging: {
    filter: string;
  } & (
    | { console: {} /* eslint-disable-line @typescript-eslint/ban-types */ }
    | { forward: {} /* eslint-disable-line @typescript-eslint/ban-types */ }
  );
  tracing?: {
    filter: string;
  } & CompiledOtelTraceExporter;
  metrics?: {
    temporality?: 'cumulative' | 'delta';
  } & (PrometheusMetricsExporter | CompiledOtelMetricsExporter);
};

export interface WorkerOptions {
  /**
   * A human-readable string that can identify your worker
   */
  identity: string;
  /**
   * A string that should be unique to the exact worker code/binary being executed
   */
  buildId: string;

  /**
   * The task queue the worker will pull from
   */
  taskQueue: string;

  maxConcurrentActivityTaskExecutions: number;
  maxConcurrentWorkflowTaskExecutions: number;
  maxConcurrentLocalActivityExecutions: number;

  /**
   * If set to `false` this worker will only handle workflow tasks and local activities, it will not
   * poll for activity tasks.
   */
  enableNonLocalActivities: boolean;

  /**
   * How long a workflow task is allowed to sit on the sticky queue before it is timed out
   * and moved to the non-sticky queue where it may be picked up by any worker.
   */
  stickyQueueScheduleToStartTimeoutMs: number;

  /**
   * Maximum number of Workflow instances to cache before automatic eviction
   */
  maxCachedWorkflows: number;
  /**
   * Longest interval for throttling activity heartbeats
   * @default 60 seconds
   */
  maxHeartbeatThrottleIntervalMs: number;

  /**
   * Default interval for throttling activity heartbeats in case
   * `ActivityOptions.heartbeat_timeout` is unset.
   * When the timeout *is* set in the `ActivityOptions`, throttling is set to
   * `heartbeat_timeout * 0.8`.
   * @default 30 seconds
   */
  defaultHeartbeatThrottleIntervalMs: number;

  /**
   * Sets the maximum number of activities per second the task queue will dispatch, controlled
   * server-side. Note that this only takes effect upon an activity poll request. If multiple
   * workers on the same queue have different values set, they will thrash with the last poller
   * winning.
   */
  maxTaskQueueActivitiesPerSecond?: number;

  /**
   * Limits the number of activities per second that this worker will process. The worker will
   * not poll for new activities if by doing so it might receive and execute an activity which
   * would cause it to exceed this limit. Must be a positive floating point number.
   */
  maxActivitiesPerSecond?: number;
}

/** Log level - must match rust log level names */
export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  /** Log message */
  message: string;
  /**
   * Time since epoch [seconds, nanos].
   *
   * Should be switched to bigint once it is supported in neon.
   */
  timestamp: [number, number];
  /** Log level */
  level: LogLevel;
}

/**
 * Which version of the executable to run.
 */
export type EphemeralServerExecutable =
  | {
      type: 'cached-download';
      /**
       * Download destination directory or the system's temp directory if none set.
       */
      downloadDir?: string;
      /**
       * Optional version, can be set to a specific server release or "default" or "latest".
       *
       * At the time of writing the the server is released as part of the Java SDK - (https://github.com/temporalio/sdk-java/releases).
       *
       * @default "default" - get the best version for the current SDK version.
       */
      version?: string;
    }
  | {
      type: 'existing-path';
      /** Path to executable */
      path: string;
    };

/**
 * Configuration for the time-skipping test server.
 */
export interface TimeSkippingServerConfig {
  type: 'time-skipping';
  executable?: EphemeralServerExecutable;
  /**
   * Optional port to listen on, defaults to find a random free port.
   */
  port?: number;
  /**
   * Extra args to pass to the executable command.
   */
  extraArgs?: string[];
}

/**
 * Configuration for the Temporal CLI dev server.
 */
export interface DevServerConfig {
  type: 'dev-server';
  executable?: EphemeralServerExecutable;
  /**
   * Namespace to use - created at startup.
   *
   * @default "default"
   */
  namespace?: string;
  /**
   * IP to bind to.
   *
   * @default 127.0.0.1
   */
  ip?: string;
  /**
   * Sqlite DB filename if persisting or non-persistent if none (default).
   */
  db_filename?: string;
  /**
   * Whether to enable the UI.
   *
   * @default false
   */
  ui?: boolean;
  /**
   * Log format and level
   * @default { format: "pretty", level" "warn" }
   */
  log?: { format: string; level: string };
  /**
   * Optional port to listen on, defaults to find a random free port.
   */
  port?: number;
  /**
   * Extra args to pass to the executable command.
   */
  extraArgs?: string[];
}

/**
 * Configuration for spawning an ephemeral Temporal server.
 *
 * Both the time-skipping test server and Temporal CLI dev server are supported.
 */
export type EphemeralServerConfig = TimeSkippingServerConfig | DevServerConfig;

export interface Worker {
  type: 'Worker';
}
export interface Runtime {
  type: 'Runtime';
}
export interface Client {
  type: 'Client';
}
export interface EphemeralServer {
  type: 'EphemeralServer';
}
export interface HistoryPusher {
  type: 'HistoryPusher';
}
export interface ReplayWorker {
  type: 'ReplayWorker';
  worker: Worker;
  pusher: HistoryPusher;
}

export declare type Callback<T> = (err: Error, result: T) => void;
export declare type PollCallback = (err: Error, result: ArrayBuffer) => void;
export declare type WorkerCallback = (err: Error, result: Worker) => void;
export declare type ReplayWorkerCallback = (err: Error, worker: ReplayWorker) => void;
export declare type ClientCallback = (err: Error, result: Client) => void;
export declare type VoidCallback = (err: Error, result: void) => void;
export declare type LogsCallback = (err: Error, result: LogEntry[]) => void;

export declare function newRuntime(telemOptions: CompiledTelemetryOptions): Runtime;
export declare function newClient(runtime: Runtime, clientOptions: ClientOptions, callback: ClientCallback): void;
export declare function newWorker(client: Client, workerOptions: WorkerOptions, callback: WorkerCallback): void;
export declare function newReplayWorker(
  runtime: Runtime,
  workerOptions: WorkerOptions,
  callback: ReplayWorkerCallback
): void;
export declare function pushHistory(
  pusher: HistoryPusher,
  workflowId: string,
  history: ArrayBuffer,
  callback: VoidCallback
): void;
export declare function closeHistoryStream(pusher: HistoryPusher): void;
export declare function workerInitiateShutdown(worker: Worker, callback: VoidCallback): void;
export declare function workerFinalizeShutdown(worker: Worker): void;
export declare function clientUpdateHeaders(
  client: Client,
  headers: Record<string, string>,
  callback: VoidCallback
): void;
export declare function clientClose(client: Client): void;
export declare function runtimeShutdown(runtime: Runtime, callback: VoidCallback): void;
export declare function pollLogs(runtime: Runtime, callback: LogsCallback): void;
export declare function workerPollWorkflowActivation(
  worker: Worker,
  spanContext: SpanContext,
  callback: PollCallback
): void;
export declare function workerCompleteWorkflowActivation(
  worker: Worker,
  spanContext: SpanContext,
  result: ArrayBuffer,
  callback: VoidCallback
): void;
export declare function workerPollActivityTask(worker: Worker, spanContext: SpanContext, callback: PollCallback): void;
export declare function workerCompleteActivityTask(
  worker: Worker,
  spanContext: SpanContext,
  result: ArrayBuffer,
  callback: VoidCallback
): void;
export declare function workerRecordActivityHeartbeat(worker: Worker, heartbeat: ArrayBuffer): void;
export declare function getTimeOfDay(): [number, number];
export declare function startEphemeralServer(
  runtime: Runtime,
  config: EphemeralServerConfig,
  sdkVersion: string,
  callback: Callback<EphemeralServer>
): void;
export declare function shutdownEphemeralServer(server: EphemeralServer, callback: Callback<EphemeralServer>): void;
export declare function getEphemeralServerTarget(server: EphemeralServer): string;

export { ShutdownError, TransportError, UnexpectedError } from './errors';
