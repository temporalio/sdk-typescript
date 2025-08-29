import { native } from '@temporalio/core-bridge';
import { Logger, LogLevel } from '@temporalio/common';
import { Duration, msToNumber } from '@temporalio/common/lib/time';
import { DefaultLogger } from './logger';
import { NativeLogCollector } from './runtime-logger';

/**
 * Options used to create a Temporal Runtime.
 * These are mostly about logging and telemetry configuration.
 */
export interface RuntimeOptions {
  /**
   * A logger that will receive log messages emitted by the SDK, as well as through the
   * [Workflow](https://typescript.temporal.io/api/namespaces/workflow#log) and
   * [Activity](https://typescript.temporal.io/api/namespaces/activity#log) context loggers.
   *
   * By default, the Runtime's logger outputs everything to stderr, filtering out
   * messages below the `INFO` level. To customize this behavior, instantiate a
   * {@link DefaultLogger} with a different log level and a custom output function. Refer to
   * [this sample](https://github.com/temporalio/samples-typescript/tree/main/hello-world/src/sample.ts)
   * for an example.
   *
   * Note that by default, log messages emitted from the native side of the SDK are printed directly
   * to the console, _independently of `RuntimeOptions.logger`_ – that is, this option only applies
   * to log messages emitted from the TS side of the SDK. See {@link TelemetryOptions.logging} on
   * how to turn on forwarding of native logs to the TS logger.
   */
  logger?: Logger;

  /**
   * Options for Core-side telemetry, including logs and metrics.
   */
  telemetryOptions?: TelemetryOptions;

  /**
   * Automatically shutdown workers on any of these signals.
   *
   * @default
   * ```ts
   * ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGUSR2']
   * ```
   */
  shutdownSignals?: NodeJS.Signals[];
}

// Telemetry Options ///////////////////////////////////////////////////////////////////////////////

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
   * If set to `true`, do not prefix metrics with `temporal_`.
   *
   * @deprecated Use `metrics.metricPrefix` instead
   */
  noTemporalPrefixForMetrics?: boolean;

  /**
   * Control where to send log messages emitted by native code.
   *
   * ### Log Forwarding
   *
   * By default, logs emitted by the native side of the SDK are printed directly to the console,
   * _independently of `RuntimeOptions.logger`_. To enable forwarding of those log messages to the
   * TS side logger, add the `forward` property to the `logging` object.
   *
   * For example:
   *
   * ```ts
   * Runtime.install({
   *   logger: new DefaultLogger('INFO'),
   *   telemetryOptions: {
   *     logging: {
   *       filter: { core: 'INFO', other: 'WARN' },
   *       forward: {},
   *     },
   *   },
   * });
   * ```
   *
   * Note that when log forwarding is enabled, all log messages sent to the runtime logger are
   * internally buffered for 100 ms, to allow global sorting of messages from different sources
   * based on their absolute timestamps. This helps reduce incoherencies in the order of messages,
   * notably those emitted through the Workflow Logging API vs those emitted through Core.
   *
   * However, in some situations, log messages may still appear out of order, e.g. when a Workflow
   * Activation takes longer than 100ms to complete or when log flow exceeds the buffer's capacity
   * (2000 messages).
   */
  logging?: LogExporterConfig;

  /**
   * Control exporting {@link NativeConnection} and {@link Worker} metrics.
   *
   * Turned off by default.
   */
  metrics?: MetricsExporterConfig;

  /**
   * @deprecated Core SDK tracing is no longer supported. This option is ignored.
   */
  tracing?: unknown;
}

// Log Exporter ////////////////////////////////////////////////////////////////////////////////////

/**
 * Configuration for logs emitted by the native side of the SDK.
 *
 * @see {@link TelemetryOptions.logging}
 */
export type LogExporterConfig = {
  /**
   * Determines the verboseness of log output emitted by the native side of the SDK.
   *
   * This can be specified either as an (env filter format)[https://docs.rs/tracing-subscriber/0.2.20/tracing_subscriber/struct.EnvFilter.html]
   * string, or as a {@link CoreLogFilterOptions} object.
   *
   * Note that if log forwarding is enabled, then the configured {@link Runtime.logger}
   * may apply further filtering on top of this.
   *
   * **BACKWARD COMPATIBILITY**
   *
   * If `logging.filter` is missing, the following legacy values (if present) will be used instead (in the given order):
   * - {@link ForwardLogger.forward.level} => `makeTelemetryFilterString({ core: level, other: level })`
   * - {@link TelemetryOptions.tracingFilter}
   * - Default value of `makeTelemetryFilterString({ core: 'WARN', other: 'ERROR'})`
   *
   * @default
   * `{ core: 'WARN', other: 'ERROR'}` (with some exceptions, as described in backward compatibility note above).
   */
  filter?: string | CoreLogFilterOptions;
} & Partial<ConsoleLogger | ForwardLogger>;

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
 * Options for configuring the verboseness of log output emitted by the native side of the SDK.
 */
export interface CoreLogFilterOptions {
  /**
   * Determines which level of verbosity to keep for _SDK Core_'s related events.
   * Any event with a verbosity level less than that value will be discarded.
   * Possible values are, in order: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'.
   */
  core: LogLevel;

  /**
   * Determines which level of verbosity to keep for events related to third
   * party native packages imported by SDK Core. Any event with a verbosity level
   * less than that value will be discarded. Possible values are, in order:
   * 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'.
   *
   * @defaults `'ERROR'`.
   */
  other?: LogLevel;
}

// Metrics Exporter ////////////////////////////////////////////////////////////////////////////////

/**
 * Configuration for exporting metrics emitted by Core.
 */
export type MetricsExporterConfig = {
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

// Compile Options ////////////////////////////////////////////////////////////////////////////////

/**
 * @hidden
 * @internal
 */
export interface CompiledRuntimeOptions {
  shutdownSignals: NodeJS.Signals[];
  telemetryOptions: native.RuntimeOptions;
  logger: Logger;
}

export function compileOptions(options: RuntimeOptions): CompiledRuntimeOptions {
  const { metrics, noTemporalPrefixForMetrics } = options.telemetryOptions ?? {}; // eslint-disable-line deprecation/deprecation
  const [logger, logExporter] = compileLoggerOptions(options);

  return {
    logger,
    shutdownSignals: options.shutdownSignals ?? ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGUSR2'],
    telemetryOptions: {
      logExporter,
      telemetry: {
        metricPrefix: metrics?.metricPrefix ?? (noTemporalPrefixForMetrics ? '' : 'temporal_'),
        attachServiceName: metrics?.attachServiceName ?? true,
      },
      metricsExporter:
        metrics && isPrometheusMetricsExporter(metrics)
          ? ({
              type: 'prometheus',
              socketAddr: metrics.prometheus.bindAddress,
              countersTotalSuffix: metrics.prometheus.countersTotalSuffix ?? false,
              unitSuffix: metrics.prometheus.unitSuffix ?? false,
              useSecondsForDurations: metrics.prometheus.useSecondsForDurations ?? false,
              histogramBucketOverrides: metrics.prometheus.histogramBucketOverrides ?? {},
              globalTags: metrics.globalTags ?? {},
            } satisfies native.MetricExporterOptions)
          : metrics && isOtelCollectorExporter(metrics)
            ? ({
                type: 'otel',
                url: metrics.otel.url,
                protocol: metrics.otel.http ? 'http' : 'grpc',
                headers: metrics.otel.headers ?? {},
                metricPeriodicity: msToNumber(metrics.otel.metricsExportInterval ?? '1s'),
                useSecondsForDurations: metrics.otel.useSecondsForDurations ?? false,
                metricTemporality: metrics.otel.temporality ?? metrics.temporality ?? 'cumulative', // eslint-disable-line deprecation/deprecation
                histogramBucketOverrides: metrics.otel.histogramBucketOverrides ?? {},
                globalTags: metrics.globalTags ?? {},
              } satisfies native.MetricExporterOptions)
            : null,
    },
  };
}

function compileLoggerOptions(options: RuntimeOptions): [Logger, native.LogExporterOptions] {
  const { logging, tracingFilter } = options.telemetryOptions ?? {}; // eslint-disable-line deprecation/deprecation

  const logger = options.logger ?? new DefaultLogger('INFO');

  // Unfortunately, "filter" has changed place and semantics a few times in the past, and we want to
  // do our best not to break existing users, so this gets a bit more complex than it should be.
  const defaultFilter = tracingFilter ?? makeTelemetryFilterString({ core: 'WARN', other: 'ERROR' });
  let loggingFilter: string | undefined = undefined;
  if (logging?.filter) {
    if (typeof logging.filter === 'string') {
      loggingFilter = logging.filter;
    } else if (typeof logging.filter === 'object') {
      loggingFilter = makeTelemetryFilterString(logging.filter);
    } else {
      throw new TypeError('Invalid logging filter');
    }
  }
  // eslint-disable-next-line deprecation/deprecation
  const forwardLevel = (logging as ForwardLogger | undefined)?.forward?.level;
  const forwardLevelFilter =
    forwardLevel &&
    makeTelemetryFilterString({
      core: forwardLevel,
      other: forwardLevel,
    });

  if (logging && isForwardingLogger(logging)) {
    const collector = new NativeLogCollector(logger);
    return [
      collector.logger,
      {
        type: 'forward',
        filter: loggingFilter ?? forwardLevelFilter ?? defaultFilter,
        receiver: collector.receive,
      },
    ];
  } else {
    return [
      logger,
      {
        type: 'console',
        filter: loggingFilter ?? defaultFilter,
      },
    ];
  }
}

// Utilities //////////////////////////////////////////////////////////////////////////////////////

/**
 * @deprecated Use {@link CoreLogFilterOptions} instead.
 */
export type MakeTelemetryFilterStringOptions = CoreLogFilterOptions;

/**
 * A helper to build a filter string for use in `RuntimeOptions.telemetryOptions.tracingFilter`.
 *
 * Note that one may instead simply pass a {@link CoreLogFilterOptions} object directly to
 * `RuntimeOptions.telemetryOptions.logging.filter`. This function may however still be useful
 * in some particular use cases and will therefore be kept around.
 */
export function makeTelemetryFilterString(options: CoreLogFilterOptions): string {
  const { core, other } = options;
  return `${other ?? 'ERROR'},temporal_sdk_core=${core},temporal_client=${core},temporal_sdk=${core}`;
}

function isOtelCollectorExporter(metrics: MetricsExporterConfig): metrics is OtelCollectorExporter {
  return 'otel' in metrics && typeof metrics.otel === 'object';
}

function isPrometheusMetricsExporter(metrics: MetricsExporterConfig): metrics is PrometheusMetricsExporter {
  return 'prometheus' in metrics && typeof metrics.prometheus === 'object';
}

function isForwardingLogger(options: LogExporterConfig): boolean {
  return 'forward' in options && typeof options.forward === 'object';
}
