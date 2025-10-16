import type { ClientOptions } from './client';

export interface ClientPlugin {
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
   *   options: The client configuration to potentially modify.
   *
   * Returns:
   *   The modified client configuration.
   */
  configureClient(options: ClientOptions): ClientOptions;
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function isClientPlugin(p: any): p is ClientPlugin {
  return 'configureClient' in p;
}
