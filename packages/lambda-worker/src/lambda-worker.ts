import type { Context } from 'aws-lambda';
import type { WorkerDeploymentVersion } from '@temporalio/common';
import { type WorkerOptions, type NativeConnectionOptions, type Logger, NativeConnection, Worker, DefaultLogger } from '@temporalio/worker';
import type { ClientConnectConfig, LoadClientProfileOptions } from '@temporalio/envconfig';
import {
  LAMBDA_WORKER_DEFAULTS,
  DEFAULT_SHUTDOWN_DEADLINE_BUFFER_MS,
  MINIMUM_WORK_TIME_MS,
  WARN_WORK_TIME_MS,
} from './defaults';
import { loadLambdaClientConnectConfig } from './config';
import type { LambdaWorkerConfig, LambdaHandler } from './types';

/** @internal Dependency injection for testing. */
export interface WorkerDeps {
  connect: (options: NativeConnectionOptions) => Promise<NativeConnection>;
  createWorker: (options: WorkerOptions) => Promise<Worker>;
  loadConnectConfig: (options?: Partial<LoadClientProfileOptions>) => ClientConnectConfig;
  logger: Logger;
}

const defaultDeps: WorkerDeps = {
  connect: (opts) => NativeConnection.connect(opts),
  createWorker: (opts) => Worker.create(opts),
  loadConnectConfig: loadLambdaClientConnectConfig,
  logger: new DefaultLogger('INFO'),
};

/**
 * @internal Replaceable deps for testing. Mutate properties on this object
 * to swap implementations; call `_resetDeps()` to restore defaults.
 */
export const _deps: WorkerDeps = { ...defaultDeps };

/** @internal Reset deps to defaults. */
export function _resetDeps(): void {
  Object.assign(_deps, defaultDeps);
}

/**
 * Create an AWS Lambda handler that runs a Temporal Worker for the duration of each invocation.
 *
 * The handler connects to Temporal, creates a Worker, polls for tasks until the Lambda deadline
 * approaches, then gracefully shuts down and runs any registered shutdown hooks.
 *
 * @param version - The worker deployment version. Worker versioning is always enabled.
 * @param configure - Callback to customize the pre-populated {@link LambdaWorkerConfig}.
 *   Mutate the config object directly (e.g., set `config.workerOptions.taskQueue`).
 * @returns A Lambda handler function.
 *
 * @example
 * ```ts
 * import { runWorker } from '@temporalio/lambda-worker';
 * import * as activities from './activities';
 *
 * export const handler = runWorker(
 *   { buildId: 'v1.0.0', deploymentName: 'my-service' },
 *   (config) => {
 *     config.workerOptions.taskQueue = 'my-task-queue';
 *     config.workerOptions.workflowBundle = require('./workflow-bundle.json');
 *     config.workerOptions.activities = activities;
 *   },
 * );
 * ```
 */
export function runWorker(
  version: WorkerDeploymentVersion,
  configure: (config: LambdaWorkerConfig) => void
): LambdaHandler {
  // Build config with Lambda defaults pre-applied
  const config: LambdaWorkerConfig = {
    workerOptions: { ...LAMBDA_WORKER_DEFAULTS },
    shutdownHooks: [],
  };

  // Pre-populate taskQueue from env var if available
  const envTaskQueue = process.env['TEMPORAL_TASK_QUEUE'];
  if (envTaskQueue) {
    config.workerOptions.taskQueue = envTaskQueue;
  }

  // Load client connect config (done once at init, not per invocation)
  const connectConfig = _deps.loadConnectConfig(config.envConfigOptions);

  // Let the user customize
  configure(config);

  // Validate
  if (!config.workerOptions.taskQueue) {
    throw new Error(
      'taskQueue is required: set config.workerOptions.taskQueue in the configure callback ' +
        'or set the TEMPORAL_TASK_QUEUE environment variable'
    );
  }

  const shutdownDeadlineBufferMs = config.shutdownDeadlineBufferMs ?? DEFAULT_SHUTDOWN_DEADLINE_BUFFER_MS;

  // Return the Lambda handler
  return async (_event: unknown, context: Context): Promise<void> => {
    const logger = _deps.logger;

    // Calculate available work time
    const remainingMs = context.getRemainingTimeInMillis();
    const workTimeMs = remainingMs - shutdownDeadlineBufferMs;

    if (workTimeMs <= MINIMUM_WORK_TIME_MS) {
      throw new Error(
        `Insufficient time for Lambda worker: ${remainingMs}ms remaining, ` +
          `${shutdownDeadlineBufferMs}ms shutdown buffer, only ${workTimeMs}ms work time ` +
          `(minimum: ${MINIMUM_WORK_TIME_MS}ms)`
      );
    }
    if (workTimeMs < WARN_WORK_TIME_MS) {
      logger.warn('Low work time available for Lambda worker', {
        remainingMs,
        shutdownDeadlineBufferMs,
        workTimeMs,
      });
    }

    // Build per-invocation identity from Lambda context
    const identity = `${context.awsRequestId}@${context.invokedFunctionArn}`;

    // Merge connection options: envconfig base + user overrides
    const connectionOptions: NativeConnectionOptions = {
      ...connectConfig.connectionOptions,
      ...config.connectionOptions,
    };

    const connection = await _deps.connect(connectionOptions);
    try {
      // Build worker options: user config + managed fields
      const namespace = config.namespace ?? connectConfig.namespace ?? 'default';
      const workerOptions: WorkerOptions = {
        ...config.workerOptions,
        connection,
        namespace,
        identity,
        workerDeploymentOptions: {
          version,
          useWorkerVersioning: true,
          defaultVersioningBehavior: 'PINNED',
        },
      } as WorkerOptions;

      const worker = await _deps.createWorker(workerOptions);

      // Run worker until timeout, then runUntil triggers graceful shutdown
      await worker.runUntil(
        new Promise<void>((resolve) => {
          setTimeout(resolve, workTimeMs);
        })
      );
    } finally {
      // Run shutdown hooks (in order, error-resilient)
      for (const hook of config.shutdownHooks) {
        try {
          await hook();
        } catch (err) {
          logger.error('Lambda worker shutdown hook failed', { error: err });
        }
      }

      // Close connection
      try {
        await connection.close();
      } catch (err) {
        logger.error('Failed to close Temporal connection', { error: err });
      }
    }
  };
}
