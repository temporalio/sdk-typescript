import type { Context } from 'aws-lambda';
import type { WorkerOptions, NativeConnectionOptions } from '@temporalio/worker';
import type { LoadClientProfileOptions } from '@temporalio/envconfig';

/**
 * A function called after the worker stops on each invocation.
 * Errors are caught, logged, and do not prevent subsequent hooks from running.
 */
export type ShutdownHook = () => Promise<void> | void;

/**
 * Configuration object passed to the {@link runWorker} configure callback.
 *
 * Pre-populated with Lambda-tuned defaults. The user should set `workerOptions.taskQueue`,
 * register activities/workflows, and override any defaults as needed.
 */
export interface LambdaWorkerConfig {
  /**
   * Worker options, pre-populated with Lambda-appropriate defaults.
   *
   * The user must set at least `taskQueue` (or set the `TEMPORAL_TASK_QUEUE` env var).
   * Typically also sets `activities` and `workflowBundle` (prefer pre-bundled workflows
   * over `workflowsPath` to avoid bundling overhead on Lambda cold starts).
   *
   * The following fields are managed internally and will be overridden per-invocation:
   * `connection`, `namespace`, `identity`, `workerDeploymentOptions`.
   */
  workerOptions: Partial<WorkerOptions>;

  /**
   * Connection options overrides, merged on top of values loaded via envconfig.
   */
  connectionOptions?: Partial<NativeConnectionOptions>;

  /**
   * Namespace override. Falls back to the envconfig-loaded value, then `"default"`.
   */
  namespace?: string;

  /**
   * Time in milliseconds before the Lambda invocation deadline at which the worker
   * begins its shutdown sequence (graceful drain + shutdown hooks).
   *
   * @default 7000 (5s graceful shutdown + 2s margin)
   */
  shutdownDeadlineBufferMs?: number;

  /**
   * Hooks executed in order after the worker stops on each invocation.
   * Each hook's errors are caught and logged without preventing subsequent hooks.
   */
  shutdownHooks: ShutdownHook[];

  /**
   * Options passed through to envconfig's `loadClientConnectConfig`.
   * Use this to override config file resolution or environment variable behavior.
   */
  envConfigOptions?: Partial<LoadClientProfileOptions>;
}

/**
 * The Lambda handler function returned by {@link runWorker}.
 */
export type LambdaHandler = (event: unknown, context: Context) => Promise<void>;
