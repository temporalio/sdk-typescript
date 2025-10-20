import type { ClientOptions } from './client';

/**
 * Plugin to control the configuration of a native connection.
 */
export interface ClientPlugin {
  /**
   * Gets the name of this plugin.
   */
  get name(): string;

  /**
   * Hook called when creating a client to allow modification of configuration.
   *
   * This method is called during client creation and allows plugins to modify
   * the client configuration before the client is fully initialized.
   */
  configureClient?(options: ClientOptions): ClientOptions;
}
