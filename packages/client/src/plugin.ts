import type { ClientOptions } from './client';

export interface Plugin {
  /**
   * Gets the name of this plugin.
   */
  get name(): string;

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

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function isClientPlugin(p: any): p is Plugin {
  return "configureClient" in p;
}