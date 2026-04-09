import type { LambdaWorkerConfig, ShutdownHook } from './types';

/**
 * Options for the batteries-included OTel setup.
 */
export interface OtelOptions {
  /** OTLP collector endpoint. Defaults to `OTEL_EXPORTER_OTLP_ENDPOINT` env var. */
  endpoint?: string;
  /**
   * OTel service name. Falls back to `OTEL_SERVICE_NAME` env var,
   * then `AWS_LAMBDA_FUNCTION_NAME`, then `'temporal-lambda-worker'`.
   */
  serviceName?: string;
}

/**
 * Apply batteries-included OTel defaults: tracing via OTLP gRPC exporter.
 * Registers a flush/shutdown hook on the config.
 *
 * Requires `@opentelemetry/*` peer dependencies to be installed.
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
  // Dynamic require to avoid failure when optional peer deps are not installed
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Resource } = require('@opentelemetry/resources');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

  const serviceName = resolveServiceName(options?.serviceName);
  const resource = new Resource({ [ATTR_SERVICE_NAME]: serviceName });

  const traceExporter = new OTLPTraceExporter({
    url: options?.endpoint,
  });

  const sdk = new NodeSDK({ resource, traceExporter });
  sdk.start();

  const flushHook: ShutdownHook = async () => {
    await sdk.shutdown();
  };
  config.shutdownHooks.push(flushHook);
}

/**
 * Apply tracing with a user-provided TracerProvider.
 * Registers a flush shutdown hook on the config.
 *
 * @param config - The Lambda worker config to add the shutdown hook to.
 * @param tracerProvider - A TracerProvider with a `forceFlush` or `shutdown` method.
 */
export function applyTracing(
  config: LambdaWorkerConfig,
  tracerProvider: { forceFlush?: () => Promise<void>; shutdown?: () => Promise<void> }
): void {
  const flushHook: ShutdownHook = async () => {
    if (typeof tracerProvider.shutdown === 'function') {
      await tracerProvider.shutdown();
    } else if (typeof tracerProvider.forceFlush === 'function') {
      await tracerProvider.forceFlush();
    }
  };
  config.shutdownHooks.push(flushHook);
}

function resolveServiceName(override?: string): string {
  return (
    override ?? process.env['OTEL_SERVICE_NAME'] ?? process.env['AWS_LAMBDA_FUNCTION_NAME'] ?? 'temporal-lambda-worker'
  );
}
