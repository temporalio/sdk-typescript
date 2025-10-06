import type { ReplayWorkerOptions, WorkerOptions } from './worker-options';

declare class Worker {}

/**
 * Base Plugin class for both client and worker functionality.
 * 
 * Plugins provide a way to extend and customize the behavior of Temporal clients and workers through a chain of
 * responsibility pattern. They allow you to intercept and modify client creation, service connections, worker
 * configuration, and worker execution.
 */
export interface Plugin {
  /**
   * Gets the name of this plugin.
   * 
   * Returns:
   *   The name of the plugin class.
   */
  get name(): string;

  /**
   * Initialize this plugin in the worker plugin chain.
   * 
   * This method sets up the chain of responsibility pattern by storing a reference
   * to the next plugin in the chain. It is called during worker creation to build
   * the plugin chain.
   * 
   * Args:
   *   next: The next plugin in the chain to delegate to.
   * 
   * Returns:
   *   This plugin instance for method chaining.
   */
  initWorkerPlugin(next: Plugin): Plugin;


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

  runWorker(worker: Worker): Promise<void>;
}
