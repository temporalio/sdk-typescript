import type { NativeConnection } from './connection';
import type { WorkerOptions } from './worker-options';

/**
 * Base Plugin class for both client and worker functionality.
 * 
 * Plugins provide a way to extend and customize the behavior of Temporal clients and workers through a chain of
 * responsibility pattern. They allow you to intercept and modify client creation, service connections, worker
 * configuration, and worker execution.
 */
export abstract class Plugin {
  /**
   * Reference to the next client plugin in the chain
   */
  protected nextClientPlugin?: Plugin;
  /**
   * Reference to the next worker plugin in the chain
   */
  protected nextWorkerPlugin?: Plugin;

  /**
   * Gets the fully qualified name of this plugin.
   * 
   * Returns:
   *   The fully qualified name of the plugin class (module.classname).
   */
  get name(): string {
    return (this.constructor as any).name || this.constructor.toString();
  }

  /**
   * Initialize this plugin in the client plugin chain.
   * 
   * This method sets up the chain of responsibility pattern by storing a reference
   * to the next plugin in the chain. It is called during client creation to build
   * the plugin chain.
   * 
   * Args:
   *   next: The next plugin in the chain to delegate to.
   * 
   * Returns:
   *   This plugin instance for method chaining.
   */
  initClientPlugin(next: Plugin): Plugin {
    this.nextClientPlugin = next;
    return this;
  }

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
  initWorkerPlugin(next: Plugin): Plugin {
    this.nextWorkerPlugin = next;
    return this;
  }

  /**
   * Hook called when creating a client to allow modification of configuration.
   * 
   * This method is called during client creation and allows plugins to modify
   * the client configuration before the client is fully initialized. Plugins
   * can add interceptors, modify connection parameters, or change other settings.
   * 
   * Args:
   *   config: The client configuration to potentially modify.
   * 
   * Returns:
   *   The modified client configuration.
   */
  configureClient(config: any): any {
    return this.nextClientPlugin?.configureClient(config) ?? config;
  }

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
  configureWorker(config: WorkerOptions): WorkerOptions {
    return this.nextWorkerPlugin?.configureWorker(config) ?? config;
  }
}

/**
 * Root worker plugin that provides default implementations for all plugin methods.
 * This is the final plugin in the chain and provides the actual implementation.
 */
class _RootWorkerPlugin extends Plugin {
  configureWorker(config: WorkerOptions): WorkerOptions {
    return config;
  }
}

/**
 * Build a worker plugin chain from an array of plugins.
 * 
 * @param plugins Array of plugins to chain together
 * @returns The first plugin in the chain
 */
export function buildWorkerPluginChain(plugins: Plugin[]): Plugin {
  if (plugins.length === 0) {
    return new _RootWorkerPlugin();
  }

  // Start with the root plugin at the end
  let chain: Plugin = new _RootWorkerPlugin();
  
  // Build the chain in reverse order
  for (let i = plugins.length - 1; i >= 0; i--) {
    const plugin = plugins[i];
    plugin.initWorkerPlugin(chain);
    chain = plugin;
  }
  
  return chain;
} 