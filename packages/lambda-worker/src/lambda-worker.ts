import { setTimeout } from 'timers/promises';
import type { Context } from 'aws-lambda';
import type { WorkerDeploymentVersion, Logger } from '@temporalio/common';
import {
  type WorkerOptions,
  type NativeConnectionOptions,
  type RuntimeOptions,
  NativeConnection,
  Worker,
  Runtime,
} from '@temporalio/worker';
import type { ClientConnectConfig, LoadClientProfileOptions } from '@temporalio/envconfig';
import {
  LAMBDA_WORKER_DEFAULTS,
  DEFAULT_SHUTDOWN_DEADLINE_BUFFER_MS,
  MINIMUM_WORK_TIME_MS,
  WARN_WORK_TIME_MS,
} from './defaults';
import { loadLambdaClientConnectConfig } from './config';
import { makePowertoolsLogger } from './logger-factory';
import type { LambdaWorkerConfig, LambdaHandler } from './types';

/**
 * @internal Dependency injection interface for testing.
 */
export interface WorkerDeps {
  connect: (options: NativeConnectionOptions) => Promise<{ close(): Promise<void> }>;
  createWorker: (options: WorkerOptions) => Promise<{ runUntil(p: Promise<void>): Promise<void> }>;
  loadConnectConfig: (options?: Partial<LoadClientProfileOptions>) => ClientConnectConfig;
  installRuntime: (options: RuntimeOptions) => void;
  getLogger: () => Logger;
}

const defaultDeps: WorkerDeps = {
  connect: (opts) => NativeConnection.connect(opts),
  createWorker: (opts) => Worker.create(opts),
  loadConnectConfig: loadLambdaClientConnectConfig,
  installRuntime: (opts) => Runtime.install(opts),
  getLogger: () => Runtime.instance().logger,
};

/**
 * Create an AWS Lambda handler that runs a Temporal Worker for the duration of each invocation.
 *
 * The handler connects to Temporal, creates a Worker, polls for tasks until the Lambda deadline
 * approaches, then gracefully shuts down and runs any registered shutdown hooks.
 *
 * Calling this more than once will result in an error.
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
 *     config.workerOptions.workflowBundle = { code: require('./workflow-bundle.js') };
 *     config.workerOptions.activities = activities;
 *   },
 * );
 * ```
 */
export function runWorker(
  version: WorkerDeploymentVersion,
  configure: (config: LambdaWorkerConfig) => void
): LambdaHandler {
  return _runWorkerInternal(version, configure, defaultDeps);
}

/**
 * @internal Testable implementation of runWorker with injected dependencies.
 */
export function _runWorkerInternal(
  version: WorkerDeploymentVersion,
  configure: (config: LambdaWorkerConfig) => void,
  deps: WorkerDeps
): LambdaHandler {
  const config: LambdaWorkerConfig = {
    workerOptions: {
      ...LAMBDA_WORKER_DEFAULTS,
      workerDeploymentOptions: {
        defaultVersioningBehavior: 'PINNED',
      },
    },
    runtimeOptions: {
      logger: makePowertoolsLogger(),
      shutdownSignals: [],
    },
    shutdownHooks: [],
  };

  const envTaskQueue = process.env['TEMPORAL_TASK_QUEUE'];
  if (envTaskQueue) {
    config.workerOptions.taskQueue = envTaskQueue;
  }

  const connectConfig = deps.loadConnectConfig(config.envConfigOptions);
  config.connectionOptions = { ...connectConfig.connectionOptions };
  config.namespace = connectConfig.namespace ?? 'default';

  configure(config);

  const taskQueue = config.workerOptions.taskQueue;
  if (!taskQueue) {
    throw new Error(
      'taskQueue is required: set config.workerOptions.taskQueue in the configure callback ' +
        'or set the TEMPORAL_TASK_QUEUE environment variable'
    );
  }

  // Install the Runtime with the (possibly user-modified) options
  deps.installRuntime(config.runtimeOptions);

  const shutdownDeadlineBufferMs = config.shutdownDeadlineBufferMs ?? DEFAULT_SHUTDOWN_DEADLINE_BUFFER_MS;

  return async (_event: unknown, context: Context): Promise<void> => {
    const logger = deps.getLogger();
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

    const identity = `${context.awsRequestId}@${context.invokedFunctionArn}`;

    let connection;
    try {
      connection = await deps.connect(config.connectionOptions ?? {});
      const workerOptions: WorkerOptions = {
        ...config.workerOptions,
        taskQueue,
        connection: connection as NativeConnection,
        namespace: config.namespace,
        identity,
        workerDeploymentOptions: {
          version,
          useWorkerVersioning: true,
          defaultVersioningBehavior:
            config.workerOptions.workerDeploymentOptions?.defaultVersioningBehavior ?? 'PINNED',
        },
      };

      const worker = await deps.createWorker(workerOptions);

      await worker.runUntil(setTimeout(workTimeMs));
    } finally {
      for (const hook of config.shutdownHooks) {
        try {
          await hook();
        } catch (err) {
          logger.error('Lambda worker shutdown hook failed', { error: err });
        }
      }

      try {
        if (connection) {
          await connection.close();
        }
      } catch (err) {
        logger.error('Failed to close Temporal connection', { error: err });
      }
    }
  };
}
