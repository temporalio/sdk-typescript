import { native } from '@temporalio/core-bridge';
import { Logger, LogLevel } from '@temporalio/common';
import { Duration, msToNumber } from '@temporalio/common/lib/time';
import { DefaultLogger } from './logger';

/**
 * Options used to create a Core runtime
 */
export interface RuntimeOptions {
  /**
   * Custom logger for logging events from the SDK, by default we log everything to stderr
   * at the INFO level. See https://docs.temporal.io/typescript/logging/ for more info.
   */
  logger?: Logger;

  /**
   * Automatically shut down workers on any of these signals.
   * @default
   * ```ts
   * ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGUSR2']
   * ```
   */
  shutdownSignals?: NodeJS.Signals[];

  /**
   * Options for Core-side telemetry, including logs and metrics.
   */
  telemetryOptions?: TelemetryOptions;
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
   * If set true, do not prefix metrics with `temporal_`.
   *
   * @deprecated Use `metrics.metricPrefix` instead
   */
  noTemporalPrefixForMetrics?: boolean;

  /**
   * Control where to send Rust Core logs
   */
  logging?: LogExporterConfig;

  /**
   * Control exporting {@link NativeConnection} and {@link Worker} metrics.
   *
   * Turned off by default
   */
  metrics?: MetricsExporterConfig;

  /**
   * @deprecated Core SDK tracing is no longer supported. This option is ignored.
   */
  tracing?: unknown;
}

// Log Exporter ////////////////////////////////////////////////////////////////////////////////////

/**
 * Logger types supported by Core
 */
export type LogExporterConfig = {
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

// Metrics Exporter ////////////////////////////////////////////////////////////////////////////////

/**
 * Metrics exporters supported by Core
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

export interface CompiledRuntimeOptions {
  shutdownSignals: NodeJS.Signals[];
  telemetryOptions: native.CoreRuntimeOptions;
  logger: Logger;
}

export function compileOptions(options: RuntimeOptions): CompiledRuntimeOptions {
  // eslint-disable-next-line deprecation/deprecation
  const { logging, metrics, tracingFilter, noTemporalPrefixForMetrics } = options.telemetryOptions ?? {};

  const defaultFilter = tracingFilter ?? makeTelemetryFilterString({ core: 'WARN', other: 'ERROR' });
  const loggingFilter = logging?.filter;

  // eslint-disable-next-line deprecation/deprecation
  const forwardLevel = (logging as ForwardLogger | undefined)?.forward?.level;
  const forwardLevelFilter =
    forwardLevel &&
    makeTelemetryFilterString({
      core: forwardLevel,
      other: forwardLevel,
    });

  return {
    logger: options.logger ?? new DefaultLogger('INFO'),
    shutdownSignals: options.shutdownSignals ?? ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGUSR2'],
    telemetryOptions: {
      logExporter:
        !!logging && isForwardingLogger(logging)
          ? {
              type: 'forward',
              filter: loggingFilter ?? forwardLevelFilter ?? defaultFilter,
            }
          : {
              type: 'console',
              filter: loggingFilter ?? defaultFilter,
            },
      telemetry: {
        metricPrefix: metrics?.metricPrefix ?? (noTemporalPrefixForMetrics ? '' : 'temporal_'),
        attachServiceName: metrics?.attachServiceName ?? true,
      },
      metricsExporter:
        metrics && isOtelCollectorExporter(metrics)
          ? ({
              type: 'otel',
              url: metrics.otel.url,
              http: metrics.otel.http ?? false,
              headers: metrics.otel.headers ?? {},
              metricsExportInterval: msToNumber(metrics.otel.metricsExportInterval ?? '1s'),
              // eslint-disable-next-line deprecation/deprecation
              temporality: metrics.otel.temporality ?? metrics.temporality ?? 'cumulative',
              useSecondsForDurations: metrics.otel.useSecondsForDurations ?? false,
              histogramBucketOverrides: metrics.otel.histogramBucketOverrides ?? {},
              globalTags: metrics.globalTags ?? {},
            } satisfies native.MetricExporterOptions)
          : metrics && isPrometheusMetricsExporter(metrics)
            ? ({
                type: 'prometheus',
                bindAddress: metrics.prometheus.bindAddress,
                unitSuffix: metrics.prometheus.unitSuffix ?? false,
                countersTotalSuffix: metrics.prometheus.countersTotalSuffix ?? false,
                useSecondsForDurations: metrics.prometheus.useSecondsForDurations ?? false,
                histogramBucketOverrides: metrics.prometheus.histogramBucketOverrides ?? {},
                globalTags: metrics.globalTags ?? {},
              } satisfies native.MetricExporterOptions)
            : null,
    },
  };
}

// Utilities //////////////////////////////////////////////////////////////////////////////////////

export interface MakeTelemetryFilterStringOptions {
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
   * @defaults `'INFO'`
   */
  other?: LogLevel;
}

/**
 * A helper to build a filter string for use in `RuntimeOptions.telemetryOptions.tracingFilter`.
 *
 * Example:
 *  ```
 *  telemetryOptions: {
 *    logging: {
 *     filter: makeTelemetryFilterString({ core: 'TRACE', other: 'DEBUG' });
 *     // ...
 *    },
 *  }
 * ```
 */
export function makeTelemetryFilterString(options: MakeTelemetryFilterStringOptions): string {
  const { core, other } = { other: 'INFO', ...options };
  return `${other},temporal_sdk_core=${core},temporal_client=${core},temporal_sdk=${core}`;
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
