import type { ClientOptions } from './client';

/**
 * Abstract base class for Temporal plugins.
 * 
 * Plugins provide a way to extend and customize the behavior of Temporal clients and workers through a chain of
 * responsibility pattern. They allow you to intercept and modify client creation, service connections, worker
 * configuration, and worker execution. Common customizations may include but are not limited to:
 * 
 * 1. DataConverter
 * 2. Activities
 * 3. Workflows
 * 4. Interceptors
 * 
 * A single plugin class can implement both client and worker plugin interfaces to share common logic between both
 * contexts. When used with a client, it will automatically be propagated to any workers created with that client.
 */
export interface Plugin {
  /**
   * Gets the name of this plugin.
   */
  get name(): string;

  /**
   * Initialize this plugin in the plugin chain.
   * 
   * This method sets up the chain of responsibility pattern by storing a reference
   * to the next plugin in the chain. It is called during client creation to build
   * the plugin chain. Note, this may be called twice in the case of connect().
   * 
   * Args:
   *   next: The next plugin in the chain to delegate to.
   *
   * Returns:
   *   This plugin instance for method chaining.
   */
  initClientPlugin(next: Plugin): Plugin;

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
  configureClient(config: ClientOptions): ClientOptions;
}

/**
 * Root plugin that provides default implementations for all plugin methods.
 * This is the final plugin in the chain and provides the actual implementation.
 */
class RootPlugin implements Plugin {
  name: string = 'RootPlugin';

  initClientPlugin(_next: Plugin): Plugin {
    throw new Error("Root plugin should not be initialized")
  }

  configureClient(config: ClientOptions): ClientOptions {
    return config;
  }
}

/**
 * Build a plugin chain from an array of plugins.
 * 
 * @param plugins Array of plugins to chain together
 * @returns The first plugin in the chain
 */
export function buildPluginChain(plugins: Plugin[] | undefined): Plugin {
  if (plugins === undefined || plugins.length === 0) {
    return new RootPlugin();
  }

  // Start with the root plugin at the end
  let chain: Plugin = new RootPlugin();
  
  // Build the chain in reverse order
  for (let i = plugins.length - 1; i >= 0; i--) {
    const plugin = plugins[i];
    plugin.initClientPlugin(chain);
    chain = plugin;
  }
  
  return chain;
} 