import { NativeConnectionOptions } from '@temporalio/worker';

/**
 * A data source for configuration, which can be a path to a file,
 * the string contents of a file, or raw bytes.
 */
export type ConfigDataSource = { path: string } | { data: string | Buffer };

/**
 * TLS configuration as specified as part of client configuration.
 *
 * @experimental Environment configuration is new feature and subject to change.
 */
export interface ClientConfigTLS {
  disabled?: boolean;
  serverName?: string;
  clientCert?: ConfigDataSource;
  clientKey?: ConfigDataSource;
  serverCACert?: ConfigDataSource;
}

export interface ClientConnectConfig {
  connectionOptions: NativeConnectionOptions;
  namespace?: string;
}

export interface ClientConfigProfileOptions {
  address?: string;
  namespace?: string;
  apiKey?: string;
  tls?: ClientConfigTLS;
  grpcMeta?: Record<string, string>;
}

/**
 * Options for loading a client configuration profile.
 *
 * @experimental Environment configuration is new feature and subject to change.
 */
export interface LoadClientProfileOptions {
  /** The profile to load from the config. Defaults to "default". */
  profile?: string;
  /**
   * If present, this is used as the configuration source instead of default
   * file locations. This can be a path to the file or the string/byte
   * contents of the file.
   */
  configSource?: ConfigDataSource;
  /**
   * If true, file loading is disabled. This is only used when `configSource`
   * is not present.
   */
  disableFile?: boolean;
  /** If true, environment variable loading and overriding is disabled. */
  disableEnv?: boolean;
  /** If true, will error on unrecognized keys in the TOML file. */
  configFileStrict?: boolean;
  /**
   * A dictionary of environment variables to use for loading and overrides.
   * If not provided, the current process's environment is used.
   */
  overrideEnvVars?: Record<string, string>;
}

export interface ClientConfigProfile {
  address?: string;
  namespace?: string;
  apiKey?: string;
  tls?: ClientConfigTLS;
  grpcMeta?: Record<string, string>;
}

/**
 * Options for loading client configuration.
 * @experimental Environment configuration is new feature and subject to change.
 */
export interface LoadClientConfigOptions {
  /**
   * If present, this is used as the configuration source instead of default
   * file locations. This can be a path or the string/byte contents of the
   * configuration file.
   */
  configSource?: ConfigDataSource;
  /** If true, will error on unrecognized keys in the TOML file. */
  configFileStrict?: boolean;
  /**
   * The environment variables to use for locating the
   * default config file. If not provided, the current process's
   * environment is used to check for `TEMPORAL_CONFIG_FILE`.
   */
  overrideEnvVars?: Record<string, string>;
}

/**
 * Client configuration represents a client config file.
 *
 * @experimental Environment configuration is new feature and subject to change.
 */
export interface ClientConfig {
  /** Map of profile name to its corresponding ClientConfigProfile. */
  profiles: Record<string, ClientConfigProfile>;
}

export interface ClientConfigFromTomlOptions {
  // If true, will error if there are unrecognized keys.
  strict: boolean;
}

export interface tomlClientConfig {
  profile: Record<string, tomlClientConfigProfile>;
}

export interface tomlClientConfigProfile {
  address?: string;
  namespace?: string;
  api_key?: string;
  tls?: tomlClientConfigTLS;
  codec?: tomlClientConfigCodec;
  grpc_meta?: Record<string, string>;
}

export interface tomlClientConfigTLS {
  disabled?: boolean;
  client_cert_path?: string;
  client_cert_data?: string;
  client_key_path?: string;
  client_key_data?: string;
  server_ca_cert_path?: string;
  server_ca_cert_data?: string;
  server_name?: string;
  disable_host_verification?: boolean;
}

export interface tomlClientConfigCodec {
  endpoint?: string;
  auth?: string;
}
