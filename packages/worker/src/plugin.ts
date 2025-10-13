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
   * 
   * Returns:
   *   The name of the plugin class.
   */
  get name(): string;

  /**
   * Hook called when creating a worker to allow modification of configuration.
   * 
   * This method is called during worker creation and allows plugins to modify
   * the worker configuration before the worker is fully initialized. Plugins
   * can add activities, workflows, interceptors, or change other settings.
   * 
   * Args:
   *   config: The worker configuration to potentially modify.
   * 
   * Returns:
   *   The modified worker configuration.
   */
  configureWorker(config: WorkerOptions): WorkerOptions;

  /**
   * Hook called when creating a replay worker to allow modification of configuration.
   *
   * This method is called during worker creation and allows plugins to modify
   * the worker configuration before the worker is fully initialized. Plugins
   * can add activities, workflows, interceptors, or change other settings.
   *
   * Args:
   *   config: The replay worker configuration to potentially modify.
   *
   * Returns:
   *   The modified worker configuration.
   */
  configureReplayWorker(config: ReplayWorkerOptions): ReplayWorkerOptions;

  runWorker(worker: Worker, next: (w: Worker) => Promise<void>): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function isWorkerPlugin(p: any): p is WorkerPlugin {
  return "configureWorker" in p && "configureReplayWorker" in p && "runWorker" in p;
}
