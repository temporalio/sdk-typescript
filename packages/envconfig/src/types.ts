import type { ConnectionPlugin } from '@temporalio/client';
import type { NativeConnectionOptions, NativeConnectionPlugin } from '@temporalio/worker';

/**
 * A data source for configuration, which can be a path to a file,
 * the string contents of a file, or raw bytes.
 */
export type ConfigDataSource = { path: string } | { data: string | Uint8Array };

/**
 * TLS configuration as specified as part of client configuration.
 */
export interface ClientConfigTLS {
  disabled?: boolean;
  serverName?: string;
  clientCert?: ConfigDataSource;
  clientKey?: ConfigDataSource;
  serverCACert?: ConfigDataSource;
}

/**
 * Configuration for connecting to a Temporal client, including connection options and namespace.
 */
export interface ClientConnectConfig {
  connectionOptions: NativeConnectionOptions;
  namespace?: string;
}

/**
 * Options for loading a client configuration profile.
 */
export interface LoadClientProfileOptions {
  /** The name of the profile to load from the config. Defaults to "default". */
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

/**
 * Options for {@link loadClientConnectConfig}.
 */
export interface LoadClientConnectConfigOptions extends LoadClientProfileOptions {
  /**
   * Extensions to apply to the loaded profile. After the profile is converted to connection options, each extension
   * is called in order and any plugin it returns is appended to `connectionOptions.plugins`. Extension names must be
   * unique.
   *
   * @experimental Client config extensions are an experimental feature; APIs may change without notice.
   */
  extensions?: ClientConfigExtension[];
}

/**
 * A client configuration profile with connection settings for a Temporal client.
 */
export interface ClientConfigProfile {
  address?: string;
  namespace?: string;
  apiKey?: string;
  tls?: ClientConfigTLS;
  grpcMeta?: Record<string, string>;
  /**
   * Raw extension config, keyed by extension name. Loaded from TOML tables at `profile.<profile>.ext.<name>`, which
   * are not interpreted or validated by this package (even in strict mode). Each {@link ClientConfigExtension} decodes
   * its own entry. This data may be shared between copies of the profile, so it should be treated as read-only after
   * initial load.
   *
   * @experimental Client config extensions are an experimental feature; APIs may change without notice.
   */
  ext?: Record<string, Record<string, unknown>>;
}

/**
 * Plugin returned by a {@link ClientConfigExtension}.
 *
 * The connection options returned by {@link loadClientConnectConfig} may be passed to either `Connection.connect` (from
 * `@temporalio/client`) or `NativeConnection.connect` (from `@temporalio/worker`), so a plugin that modifies connection
 * options should implement both `configureConnection` and `configureNativeConnection`. Plugins registered on a
 * connection are also passed to clients (and, for `NativeConnection`, workers) built from it, so the plugin may also
 * implement other plugin interfaces such as `ClientPlugin` or `WorkerPlugin`. `SimplePlugin` from `@temporalio/plugin`
 * implements all of these.
 *
 * @experimental Client config extensions are an experimental feature; APIs may change without notice.
 */
export type ClientConfigExtensionPlugin = ConnectionPlugin & NativeConnectionPlugin;

/**
 * An extension that takes existing config and emits a plugin to apply additional config to the client. Extensions are
 * passed to {@link loadClientConnectConfig} via {@link LoadClientConnectConfigOptions.extensions}.
 *
 * An extension's TOML config lives in the `profile.<profile>.ext.<name>` table, available as
 * `profile.ext?.[name]`. Extensions are recommended to use a `TEMPORAL_EXT_<NAME>_` prefix for their env vars.
 *
 * @experimental Client config extensions are an experimental feature; APIs may change without notice.
 */
export interface ClientConfigExtension {
  /**
   * The extension's table key under `profile.<profile>.ext`. Must be non-empty and unique among loaded extensions.
   */
  readonly name: string;

  /**
   * Reads this extension's config from the profile and env, and returns a plugin that applies it, or `undefined` if
   * there's nothing to apply. Errors thrown are wrapped with the extension name.
   */
  clientPlugin(request: ClientConfigExtensionRequest): ClientConfigExtensionPlugin | undefined;
}

/**
 * Input to {@link ClientConfigExtension.clientPlugin}.
 *
 * @experimental Client config extensions are an experimental feature; APIs may change without notice.
 */
export interface ClientConfigExtensionRequest {
  /** Profile that was loaded, after env vars have been applied (unless disabled). Must not be mutated. */
  readonly profile: ClientConfigProfile;
  /** Env to read extension env vars from, or `undefined` if env loading is disabled. */
  readonly env?: Record<string, string | undefined>;
}

/**
 * Options for loading client configuration.
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
 */
export interface ClientConfig {
  /** Map of profile name to its corresponding ClientConfigProfile. */
  profiles: Record<string, ClientConfigProfile>;
}

/**
 * Options for parsing client configuration from TOML format.
 */
export interface ClientConfigFromTomlOptions {
  // If true, will error if there are unrecognized keys.
  strict: boolean;
}
