import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry';
import type { LambdaWorkerConfig } from './types';

/**
 * Options for the batteries-included OTel setup.
 */
export interface OtelOptions {
  /**
   * OTLP gRPC collector endpoint for Core SDK metrics and SDK trace span export.
   * Defaults to `OTEL_EXPORTER_OTLP_ENDPOINT` env var, then `grpc://localhost:4317`.
   */
  endpoint?: string;

  /**
   * OTel service name. Falls back to `OTEL_SERVICE_NAME` env var,
   * then `AWS_LAMBDA_FUNCTION_NAME`, then `'temporal-lambda-worker'`.
   */
  serviceName?: string;
}

/**
 * Configure OpenTelemetry for a Lambda worker:
 *
 * - Registers Temporal SDK interceptors (`@temporalio/interceptors-opentelemetry`) for
 *   tracing Workflow, Activity, and Nexus calls via the `OpenTelemetryPlugin`.
 * - Configures Core-side telemetry so the Temporal Rust SDK exports its own metrics
 *   (workflow/activity task latencies, poll counts, etc.) via OTLP.
 *
 * Node.js-side Lambda auto-instrumentation (root spans, HTTP calls, etc.) is handled
 * by the ADOT JS Lambda layer — this function does not set up a separate `NodeSDK` or
 * `TracerProvider` to avoid conflicting with the layer.
 *
 * **Required AWS setup**: attach both Lambda layers:
 *
 * 1. [ADOT JavaScript layer](https://aws-otel.github.io/docs/getting-started/lambda/lambda-js)
 *    — auto-instruments the handler and exports Node.js-side traces.
 * 2. [ADOT Collector layer](https://aws-otel.github.io/docs/getting-started/lambda)
 *    (`aws-otel-collector-amd64`) — runs the OTel Collector as a Lambda extension,
 *    receiving Core SDK metrics via OTLP on `localhost:4317` and forwarding them to
 *    CloudWatch/X-Ray.
 *
 * Then set these environment variables:
 *
 * - `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument`
 * - `OPENTELEMETRY_COLLECTOR_CONFIG_URI=/var/task/otel-collector-config.yaml`
 *
 * **Important**: When pre-bundling Workflow code with `bundleWorkflowCode()`, you must
 * pass `makeOtelPlugins()` so Workflow interceptor modules are included in the bundle.
 * See {@link makeOtelPlugins}.
 *
 * @example
 * ```ts
 * import { runWorker } from '@temporalio/lambda-worker';
 * import { applyDefaults } from '@temporalio/lambda-worker/otel';
 *
 * export const handler = runWorker(version, (config) => {
 *   applyDefaults(config);
 *   config.workerOptions.taskQueue = 'my-queue';
 *   // ...
 * });
 * ```
 */
export function applyDefaults(config: LambdaWorkerConfig, options?: OtelOptions): void {
  const endpoint = options?.endpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'grpc://localhost:4317';

  // Configure Core-side telemetry so the Temporal Rust SDK exports its own
  // metrics (workflow/activity task latencies, poll counts, etc.) to the
  // standalone ADOT collector extension running as a Lambda layer.
  config.runtimeOptions.telemetryOptions = {
    ...config.runtimeOptions.telemetryOptions,
    metrics: {
      otel: {
        url: endpoint,
      },
    },
  };

  // Set up the OpenTelemetry plugin for Temporal SDK interceptors.
  // This traces Workflow, Activity, and Nexus calls.
  const plugins = makeOtelPlugins(endpoint, options?.serviceName);
  config.workerOptions.plugins = [...(config.workerOptions.plugins ?? []), ...plugins];
}

// TODO: Spans don't automatically get parented to the lambda invocation span, and it's not clear
// how we'd make that work, but is worth doing in the future if possible.
/**
 * Create the OpenTelemetry plugins array for use with `Worker.create()` and
 * `bundleWorkflowCode()`. When pre-bundling workflows, pass the returned plugins
 * to `bundleWorkflowCode({ plugins })` so workflow interceptor modules are included
 * in the bundle.
 *
 * @example
 * ```ts
 * import { bundleWorkflowCode } from '@temporalio/worker';
 * import { makeOtelPlugins } from '@temporalio/lambda-worker/otel';
 *
 * const plugins = makeOtelPlugins();
 * const bundle = await bundleWorkflowCode({
 *   workflowsPath: require.resolve('./workflows'),
 *   plugins,
 * });
 * ```
 */
export function makeOtelPlugins(endpoint?: string, serviceName?: string): [OpenTelemetryPlugin] {
  const resolvedEndpoint = endpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'grpc://localhost:4317';
  const resolvedServiceName =
    serviceName ??
    process.env['OTEL_SERVICE_NAME'] ??
    process.env['AWS_LAMBDA_FUNCTION_NAME'] ??
    'temporal-lambda-worker';

  const resource = new Resource({ 'service.name': resolvedServiceName });
  const traceExporter = new OTLPTraceExporter({ url: resolvedEndpoint });
  const spanProcessor = new SimpleSpanProcessor(traceExporter);

  return [new OpenTelemetryPlugin({ resource, spanProcessor })];
}
