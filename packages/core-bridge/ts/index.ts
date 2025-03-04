import { LogLevel, Duration } from '@temporalio/common';
import type { TLSConfig, ProxyConfig, HttpConnectProxyConfig } from '@temporalio/common/lib/internal-non-workflow';
import { WorkerTuner } from './worker-tuner';

export {
  WorkerTuner,
  SlotSupplier,
  ResourceBasedSlotOptions,
  ResourceBasedTunerOptions,
  FixedSizeSlotSupplier,
  CustomSlotSupplier,
  SlotInfo,
  WorkflowSlotInfo,
  ActivitySlotInfo,
  LocalActivitySlotInfo,
  SlotMarkUsedContext,
  SlotPermit,
  SlotReserveContext,
  SlotReleaseContext,
} from './worker-tuner';

export type { TLSConfig, ProxyConfig, HttpConnectProxyConfig };

/** @deprecated Import from @temporalio/common instead */
export { LogLevel };

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
   * Proxying configuration.
   */
  proxy?: ProxyConfig;

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

  /**
   * API key for Temporal. This becomes the "Authorization" HTTP header with "Bearer " prepended.
   * This is only set if RPC metadata doesn't already have an "authorization" key.
   *
   * Set statically at connection time, can be replaced later using {@link clientUpdateApiKey}.
   */
  apiKey?: string;

  /**
   * If set to true, error code labels will not be included on request failure
   * metrics emitted by this Client.
   *
   * @default false
   */
  disableErrorCodeMetricTags?: boolean;
}

/**
 * Log directly to console
 */
export interface ConsoleLogger {
  console: {}; // eslint-disable-line @typescript-eslint/no-empty-object-type
}

/**
 * Forward logs to {@link Runtime} logger
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
 */
export type Logger = ConsoleLogger | ForwardLogger;

/**
 * OpenTelemetry Collector options for exporting metrics or traces
 */
export interface OtelCollectorExporter {
  otel: {
    /**
     * URL of a gRPC OpenTelemetry collector.
     *
     * Syntax generally looks like `http://server:4317` or `grpc://server:4317` for OTLP/gRPC exporters,
     * or `http://server:4318/v1/metrics` for OTLP/HTTP exporters. Make sure to set the `http` option
     * to `true` for OTLP/HTTP endpoints.
     *
     * @format Starts with "grpc://" or "http://" for an unsecured connection (typical),
     *         or "grpcs://" or "https://" for a TLS connection.
     * @note The `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable, if set, will override this property.
     */
    url: string;

    /**
     * If set to true, the exporter will use OTLP/HTTP instead of OTLP/gRPC.
     *
     * @default false meaning that the exporter will use OTLP/gRPC.
     */
    http?: boolean;

    /**
     * Optional set of HTTP request headers to send to Collector (e.g. for authentication)
     */
    headers?: Record<string, string>;

    /**
     * Specify how frequently in metrics should be exported.
     *
     * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
     * @default 1 second
     */
    metricsExportInterval?: Duration;

    /**
     * If set to true, the exporter will use seconds for durations instead of milliseconds.
     *
     * @default false
     */
    useSecondsForDurations?: boolean;

    /**
     * Determines if the metrics exporter should use cumulative or delta temporality.

     * See the [OpenTelemetry specification](https://github.com/open-telemetry/opentelemetry-specification/blob/ce50e4634efcba8da445cc23523243cb893905cb/specification/metrics/datamodel.md#temporality)
     * for more information.
     *
     * @default 'cumulative'
     */
    temporality?: 'cumulative' | 'delta';

    /**
     * Overrides boundary values for histogram metrics.
     *
     * The key is the metric name and the value is the list of bucket boundaries.
     *
     * For example:
     *
     * ```
     * {
     *   "request_latency": [1, 5, 10, 25, 50, 100, 250, 500, 1000],
     * }
     * ```
     *
     * The metric name will apply regardless of name prefixing.
     *
     * See [this doc](https://docs.rs/opentelemetry_sdk/latest/opentelemetry_sdk/metrics/enum.Aggregation.html#variant.ExplicitBucketHistogram.field.boundaries)
     * for the exact meaning of boundaries.
     */
    histogramBucketOverrides?: Record<string, number[]>;
  };
}

interface CompiledOtelMetricsExporter {
  otel: {
    url: string;
    http: boolean;
    headers: Record<string, string> | undefined;
    metricsExportInterval: number;
    useSecondsForDurations: boolean;
    temporality: 'cumulative' | 'delta';
    histogramBucketOverrides: Record<string, number[]> | undefined;
  };
}

/**
 * Prometheus metrics exporter options
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
    /**
     * If set to true, all counter names will include a "_total" suffix.
     *
     * @default false
     */
    countersTotalSuffix?: boolean;
    /**
     * If set to true, all histograms will include the unit in their name as a suffix.
     * EX: "_milliseconds"
     *
     * @default false
     */
    unitSuffix?: boolean;
    /**
     * If set to true, the exporter will use seconds for durations instead of milliseconds.
     *
     * @default false
     */
    useSecondsForDurations?: boolean;

    /**
     * Overrides boundary values for histogram metrics.
     *
     * The key is the metric name and the value is the list of bucket boundaries.
     *
     * For example:
     *
     * ```
     * {
     *   "request_latency": [1, 5, 10, 25, 50, 100, 250, 500, 1000],
     * }
     * ```
     *
     * The metric name will apply regardless of name prefixing.
     *
     * See [this doc](https://docs.rs/opentelemetry_sdk/latest/opentelemetry_sdk/metrics/enum.Aggregation.html#variant.ExplicitBucketHistogram.field.boundaries)
     * for the exact meaning of boundaries.
     */
    histogramBucketOverrides?: Record<string, number[]>;
  };
}

interface CompiledPrometheusMetricsExporter {
  prometheus: {
    bindAddress: string;
    countersTotalSuffix: boolean;
    unitSuffix: boolean;
    useSecondsForDurations: boolean;
    histogramBucketOverrides: Record<string, number[]> | undefined;
  };
}

/**
 * Metrics exporters supported by Core
 */
export type MetricsExporter = {
  /**
   * Determines if the metrics exporter should use cumulative or delta temporality.
   * Only applies to OpenTelemetry exporter.
   *
   * @deprecated Use 'otel.temporality' instead
   */
  temporality?: 'cumulative' | 'delta';

  /**
   * A prefix to add to all metrics.
   *
   * @default 'temporal_'
   */
  metricPrefix?: string;

  /**
   * Tags to add to all metrics emitted by the worker.
   */
  globalTags?: Record<string, string>;

  /**
   * Whether to put the service_name on every metric.
   *
   * @default true
   */
  attachServiceName?: boolean;
} & (PrometheusMetricsExporter | OtelCollectorExporter);

export interface TelemetryOptions {
  /**
   * A string in the env filter format specified here:
   * https://docs.rs/tracing-subscriber/0.2.20/tracing_subscriber/struct.EnvFilter.html
   *
   * Which determines what tracing data is collected in the Core SDK.
   *
   * @deprecated Use `logging.filter` instead
   */
  tracingFilter?: string;

  /**
   * If set true, do not prefix metrics with `temporal_`.
   *
   * @deprecated Use `metrics.metricPrefix` instead
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
     * - Default value of `makeTelemetryFilterString({ core: 'WARN', other: 'ERROR'})`
     *
     * @default `makeTelemetryFilterString({ core: 'WARN', other: 'ERROR'})` (with some exceptions, as described in backward compatibility note above)
     */
    filter?: string;
  } & Partial<Logger>;

  /**
   * Control exporting {@link NativeConnection} and {@link Worker} metrics.
   *
   * Turned off by default
   */
  metrics?: MetricsExporter;

  /**
   * @deprecated Core SDK tracing is no longer supported. This option is ignored.
   */
  tracing?: unknown;
}

export type CompiledTelemetryOptions = {
  logging: {
    filter: string;
  } & (
    | { console: {} /* eslint-disable-line @typescript-eslint/no-empty-object-type */ }
    | { forward: {} /* eslint-disable-line @typescript-eslint/no-empty-object-type */ }
  );
  metrics?: {
    metricPrefix: string;
    globalTags: Record<string, string> | undefined;
    attachServiceName: boolean;
  } & (CompiledPrometheusMetricsExporter | CompiledOtelMetricsExporter);
};

export interface WorkerOptions {
  identity: string;
  buildId: string;
  useVersioning: boolean;
  taskQueue: string;
  tuner: WorkerTuner;
  nonStickyToStickyPollRatio: number;
  maxConcurrentWorkflowTaskPolls: number;
  maxConcurrentActivityTaskPolls: number;
  enableNonLocalActivities: boolean;
  stickyQueueScheduleToStartTimeoutMs: number;
  maxCachedWorkflows: number;
  maxHeartbeatThrottleIntervalMs: number;
  defaultHeartbeatThrottleIntervalMs: number;
  maxTaskQueueActivitiesPerSecond?: number;
  maxActivitiesPerSecond?: number;
  shutdownGraceTimeMs: number;
}

export type LogEntryMetadata = {
  [key: string]: string | number | boolean | LogEntryMetadata;
};

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

  /** Name of the Core subsystem that emitted that log entry */
  target: string;

  /*** Metadata fields */
  fields: LogEntryMetadata;
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
      /** How long to cache the download for. Undefined means forever. */
      ttlMs?: number;
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
   *
   * Note that the Test Server implementation may be changed to another one in the future. Therefore, there is
   * no guarantee that server options, and particularly those provided through the `extraArgs` array, will continue to
   * be supported in the future.
   */
  extraArgs?: string[];
}

/**
 * Configuration for the Temporal CLI Dev Server.
 */
export interface DevServerConfig {
  type: 'dev-server';
  executable?: EphemeralServerExecutable;
  /**
   * Sqlite DB filename if persisting or non-persistent if none (default).
   */
  dbFilename?: string;
  /**
   * Namespace to use - created at startup.
   *
   * @default "default"
   */
  namespace?: string;
  /**
   * IP to bind to.
   *
   * @default localhost
   */
  ip?: string;
  /**
   * Port to listen on; defaults to find a random free port.
   */
  port?: number;
  /**
   * Whether to enable the UI.
   *
   * @default true if `uiPort` is set; defaults to `false` otherwise.
   */
  ui?: boolean;
  /**
   * Port to listen on for the UI; if `ui` is true, defaults to `port + 1000`.
   */
  uiPort?: number;
  /**
   * Log format and level
   * @default { format: "pretty", level" "warn" }
   */
  log?: { format: string; level: string };
  /**
   * Extra args to pass to the executable command.
   *
   * Note that the Dev Server implementation may be changed to another one in the future. Therefore, there is no
   * guarantee that Dev Server options, and particularly those provided through the `extraArgs` array, will continue to
   * be supported in the future.
   */
  extraArgs?: string[];
}

/**
 * Configuration for spawning an ephemeral Temporal server.
 *
 * Both the time-skipping Test Server and Temporal CLI dev server are supported.
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

export declare function clientUpdateApiKey(client: Client, apiKey: string, callback: VoidCallback): void;

export declare function clientClose(client: Client): void;

export declare function runtimeShutdown(runtime: Runtime, callback: VoidCallback): void;

export declare function pollLogs(runtime: Runtime, callback: LogsCallback): void;

export declare function workerPollWorkflowActivation(worker: Worker, callback: PollCallback): void;

export declare function workerCompleteWorkflowActivation(
  worker: Worker,
  result: ArrayBuffer,
  callback: VoidCallback
): void;

export declare function workerPollActivityTask(worker: Worker, callback: PollCallback): void;

export declare function workerCompleteActivityTask(worker: Worker, result: ArrayBuffer, callback: VoidCallback): void;

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
