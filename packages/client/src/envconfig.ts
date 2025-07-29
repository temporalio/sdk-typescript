import * as fs from 'fs';
import { native } from '@temporalio/core-bridge';
import type { TLSConfig } from '@temporalio/common/lib/internal-non-workflow';
import type { ConnectionOptions } from './connection';

/**
 * A data source for configuration, which can be a path to a file,
 * the string contents of a file, or raw bytes.
 *
 * It is defined as a tagged union, to be consumed by other parts of the SDK.
 */

export type DataSource = { path: string } | { data: string | Buffer };

interface ClientConfigTLSJSON {
  disabled?: boolean;
  serverName?: string;
  // TODO(assess): name Ca -> CA ?
  serverCaCert?: Record<string, string>;
  clientCert?: Record<string, string>;
  clientKey?: Record<string, string>;
}

interface ClientConfigProfileJSON {
  address?: string;
  namespace?: string;
  apiKey?: string;
  tls?: ClientConfigTLSJSON;
  grpcMeta?: Record<string, string>;
}

function recordToSource(d?: Record<string, any>): DataSource | undefined {
  if (d === undefined) {
    return undefined;
  }
  if (d.data !== undefined) {
    return { data: d.data };
  }
  if (d.path !== undefined && typeof d.path === 'string') {
    return { path: d.path };
  }
  return undefined;
}

function sourceToRecord(source?: DataSource): Record<string, string> | undefined {
  if (source === undefined) {
    return undefined;
  }

  if ('path' in source) {
    return { path: source.path };
  } else {
    // source.data
    if (Buffer.isBuffer(source.data)) {
      return { data: source.data.toString('utf8') };
    } else {
      return { data: source.data };
    }
  }
}

function sourceToPathAndData(source?: DataSource): { path?: string; data?: Buffer } {
  if (!source) {
    return {};
  }
  if ('path' in source) {
    return { path: source.path };
  }
  if (Buffer.isBuffer(source.data)) {
    return { data: source.data };
  }
  return { data: Buffer.from(source.data, 'utf8') };
}

/**
 * Synchronously takes a DataSource and resolves it into its raw Buffer representation.
 * - If it's a path, it reads the file from disk, blocking the event loop.
 * - If it's content, it ensures it's a Buffer.
 */
function readSourceSync(source?: DataSource): Buffer | undefined {
  if (source === undefined) {
    return undefined;
  }

  if ('path' in source) {
    // This is correct. It reads the whole file into a Buffer asynchronously.
    return fs.readFileSync(source.path);
  }

  if (Buffer.isBuffer(source.data)) {
    return source.data;
  }

  // If it's not a buffer, it must be a string.
  return Buffer.from(source.data, 'utf8');
}

function bridgeToDataSource(bridgeSource?: native.DataSource | null): DataSource | undefined {
  if (bridgeSource == null) {
    return undefined;
  }
  if (bridgeSource.path != null) {
    return { path: bridgeSource.path };
  }
  if (bridgeSource.data != null) {
    return { data: bridgeSource.data };
  }
  throw new TypeError('Invalid DataSource object received from bridge');
}

function clientConfigTlsFromBridge(tls: native.ClientConfigProfile['tls']): ClientConfigTLS {
  return new ClientConfigTLS({
    disabled: tls?.disabled,
    serverName: tls?.serverName ?? undefined,
    serverRootCaCert: bridgeToDataSource(tls?.serverCaCert),
    clientCert: bridgeToDataSource(tls?.clientCert),
    clientPrivateKey: bridgeToDataSource(tls?.clientKey),
  });
}

function clientConfigProfileFromBridge(profile: native.ClientConfigProfile): ClientConfigProfile {
  return new ClientConfigProfile({
    address: profile.address ?? undefined,
    namespace: profile.namespace ?? undefined,
    apiKey: profile.apiKey ?? undefined,
    tls: profile.tls ? clientConfigTlsFromBridge(profile.tls) : undefined,
    grpcMeta: profile.grpcMeta,
  });
}

function clientConfigFromBridge(bridgeConfig: native.ClientConfig): ClientConfig {
  const profiles: Record<string, ClientConfigProfile> = {};
  for (const [name, profile] of Object.entries(bridgeConfig.profiles)) {
    profiles[name] = clientConfigProfileFromBridge(profile);
  }
  return new ClientConfig(profiles);
}

/**
 * Options for `ClientConfigTLS` constructor.
 */
export interface ClientConfigTLSOptions {
  disabled?: boolean;
  serverName?: string;
  serverRootCaCert?: DataSource;
  clientCert?: DataSource;
  clientPrivateKey?: DataSource;
}

/**
 * TLS configuration as specified as part of client configuration.
 *
 * This class is the TypeScript equivalent of the Python SDK's `ClientConfigTLS`.
 * @experimental
 */
export class ClientConfigTLS {
  public readonly disabled: boolean;
  public readonly serverName?: string;
  public readonly serverRootCaCert?: DataSource;
  public readonly clientCert?: DataSource;
  public readonly clientPrivateKey?: DataSource;

  constructor(options: ClientConfigTLSOptions) {
    this.disabled = options.disabled ?? false;
    this.serverName = options.serverName;
    this.serverRootCaCert = options.serverRootCaCert;
    this.clientCert = options.clientCert;
    this.clientPrivateKey = options.clientPrivateKey;
  }

  public toJSON(): ClientConfigTLSJSON {
    const json: ClientConfigTLSJSON = {};
    if (this.disabled) {
      json.disabled = this.disabled;
    }
    if (this.serverName) {
      json.serverName = this.serverName;
    }
    if (this.serverRootCaCert) {
      json.serverCaCert = sourceToRecord(this.serverRootCaCert);
    }
    if (this.clientCert) {
      json.clientCert = sourceToRecord(this.clientCert);
    }
    if (this.clientPrivateKey) {
      json.clientKey = sourceToRecord(this.clientPrivateKey);
    }
    return json;
  }

  public static fromJSON(json: ClientConfigTLSJSON): ClientConfigTLS {
    return new ClientConfigTLS({
      disabled: json.disabled,
      serverName: json.serverName,
      serverRootCaCert: recordToSource(json.serverCaCert),
      clientCert: recordToSource(json.clientCert),
      clientPrivateKey: recordToSource(json.clientKey),
    });
  }

  // TODO(assess): add doc string
  public toTLSConfig(): TLSConfig | undefined {
    if (this.disabled) {
      return undefined;
    }

    const crtBuffer = readSourceSync(this.clientCert);
    const keyBuffer = readSourceSync(this.clientPrivateKey);

    const tlsConfig: TLSConfig = {
      serverNameOverride: this.serverName,
      serverRootCACertificate: readSourceSync(this.serverRootCaCert),
      clientCertPair:
        crtBuffer && keyBuffer
          ? {
              crt: crtBuffer,
              key: keyBuffer,
            }
          : undefined,
    };
    return tlsConfig;
  }
}

// TODO(assess): determine need for "ClientConnectConfig"
interface ClientConnectConfig {
  connectionOptions: ConnectionOptions;
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
 * This is the TypeScript equivalent of the options passed to the Python SDK's
 * `ClientConfigProfile.load` method.
 *
 * @experimental
 */
export interface LoadClientProfileOptions {
  /** The profile to load from the config. Defaults to "default". */
  profile?: string;
  /**
   * If present, this is used as the configuration source instead of default
   * file locations. This can be a path to the file or the string/byte
   * contents of the file.
   */
  configSource?: DataSource;
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

// TODO(assess): docstring
export class ClientConfigProfile {
  public readonly address?: string;
  public readonly namespace?: string;
  public readonly apiKey?: string;
  public readonly tls?: ClientConfigTLS;
  public readonly grpcMeta: Record<string, string>;

  public constructor(options: ClientConfigProfileOptions) {
    this.address = options.address;
    this.namespace = options.namespace;
    this.apiKey = options.apiKey;
    this.tls = options.tls;
    this.grpcMeta = options.grpcMeta ?? {};
  }

  /**
   * Loads a single client profile from environment variables and/or a TOML file.
   */
  public static load(options: LoadClientProfileOptions = {}): ClientConfigProfile {
    const { path, data } = sourceToPathAndData(options.configSource);
    const bridgeProfile = native.loadClientConnectConfig(
      options.profile ?? null,
      path ?? null,
      data ?? null,
      options.disableFile ?? false,
      options.disableEnv ?? false,
      options.configFileStrict ?? false,
      options.overrideEnvVars ?? null
    );
    return clientConfigProfileFromBridge(bridgeProfile);
  }

  public toJSON(): ClientConfigProfileJSON {
    return {
      address: this.address,
      namespace: this.namespace,
      apiKey: this.apiKey,
      tls: this.tls?.toJSON(),
      grpcMeta: this.grpcMeta,
    };
  }

  public static fromJSON(json: ClientConfigProfileJSON): ClientConfigProfile {
    return new ClientConfigProfile({
      address: json.address,
      namespace: json.namespace,
      apiKey: json.apiKey,
      tls: json.tls ? ClientConfigTLS.fromJSON(json.tls) : undefined,
      grpcMeta: json.grpcMeta,
    });
  }

  // TODO(assess): docstring
  public toClientConnectConfig(): ClientConnectConfig {
    if (!this.address) {
      throw new Error("Configuration profile must contain an 'address' to be used for client connection");
    }

    const tlsConfig = this.tls?.toTLSConfig();

    return {
      namespace: this.namespace,
      connectionOptions: {
        address: this.address,
        apiKey: this.apiKey,
        tls: tlsConfig,
        metadata: this.grpcMeta,
      },
    };
  }
}

/**
 * Options for loading client configuration.
 * @experimental
 */
export interface LoadClientConfigOptions {
  /**
   * If present, this is used as the configuration source instead of default
   * file locations. This can be a path to the file or the string/byte
   * contents of the file.
   */
  configSource?: DataSource;
  /**
   * If true, file loading is disabled. This is only used when `configSource`
   * is not present.
   */
  disableFile?: boolean;
  /** If true, will error on unrecognized keys in the TOML file. */
  configFileStrict?: boolean;
  /**
   * The environment variables to use for locating the
   * default config file. If not provided, the current process's
   * environment is used to check for ``TEMPORAL_CONFIG_FILE``.
   */
  overrideEnvVars?: Record<string, string>;
}

interface ClientConfigJSON {
  profiles: Record<string, ClientConfigProfileJSON>;
}

// TODO(assess): update docstrings
/**
 * Client configuration loaded from TOML and environment variables.
 *
 * This class is the TypeScript equivalent of the Python SDK's `ClientConfig`.
 * It contains a mapping of profile names to client profiles.
 *
 * @experimental
 */
export class ClientConfig {
  /** Map of profile name to its corresponding ClientConfigProfile. */
  public readonly profiles: Record<string, ClientConfigProfile>;

  /**
   * Load all client profiles from given sources.
   *
   * This does not apply environment variable overrides to the profiles, it
   * only uses an environment variable to find the default config file path
   * (`TEMPORAL_CONFIG_FILE`). To get a single profile with environment variables
   * applied, use {@link ClientConfigProfile.load}.
   */
  public static load(options: LoadClientConfigOptions = {}): ClientConfig {
    const { path, data } = sourceToPathAndData(options.configSource);
    const bridgeConfig = native.loadClientConfig(
      path ?? null,
      data ?? null,
      options.disableFile ?? false,
      options.configFileStrict ?? false,
      options.overrideEnvVars ?? null
    );
    return clientConfigFromBridge(bridgeConfig);
  }

  /**
   * A convenience function that loads a single client profile and converts it to connect options.
   *
   * @param options Options for loading the client profile.
   * @returns A {@link ConnectionOptions} object that can be used to connect a client.
   */
  public static loadClientConnectConfig(options: LoadClientProfileOptions = {}): ClientConnectConfig {
    return ClientConfigProfile.load(options).toClientConnectConfig();
  }

  public constructor(profiles: Record<string, ClientConfigProfile>) {
    this.profiles = profiles;
  }

  public toJSON(): ClientConfigJSON {
    const profiles: Record<string, ClientConfigProfileJSON> = {};
    for (const [name, profile] of Object.entries(this.profiles)) {
      profiles[name] = profile.toJSON();
    }
    return { profiles };
  }

  public static fromJSON(json: ClientConfigJSON): ClientConfig {
    const profiles: Record<string, ClientConfigProfile> = {};
    for (const [name, profile] of Object.entries(json.profiles)) {
      profiles[name] = ClientConfigProfile.fromJSON(profile);
    }
    return new ClientConfig(profiles);
  }
}
