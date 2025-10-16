import type { ReplayWorkerOptions, WorkerOptions } from './worker-options';
import type { Worker } from './worker';

/**
 * Base Plugin class for worker functionality.
 *
 * Plugins provide a way to extend and customize the behavior of Temporal workers.
 * They allow you to intercept and modify worker configuration and worker execution.
 */
export interface WorkerPlugin {
  /**
   * Gets the name of this plugin.
   */
  get name(): string;

  /**
   * Hook called when creating a worker to allow modification of configuration.
   *
   * This method is called during worker creation and allows plugins to modify
   * the worker configuration before the worker is fully initialized. Plugins
   * can add activities, workflows, interceptors, or change other settings.
   */
  configureWorker(options: WorkerOptions): WorkerOptions;

  /**
   * Hook called when creating a replay worker to allow modification of configuration.
   *
   * This method is called during worker creation and allows plugins to modify
   * the worker configuration before the worker is fully initialized. Plugins
   * can add activities, workflows, interceptors, or change other settings.
   */
  configureReplayWorker(options: ReplayWorkerOptions): ReplayWorkerOptions;

  /**
   * Hook called when running a worker.
   *
   * This method is not called when running a replay worker, as activities will not be
   * executed, and global state can't affect the workflow.
   */
  runWorker(worker: Worker, next: (w: Worker) => Promise<void>): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function isWorkerPlugin(p: any): p is WorkerPlugin {
  return 'configureWorker' in p && 'configureReplayWorker' in p && 'runWorker' in p;
}
