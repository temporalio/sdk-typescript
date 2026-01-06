import { readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse, stringify, TomlTable } from 'smol-toml';
import { filterNullAndUndefined } from '@temporalio/common/lib/internal-workflow/objects-helpers';
import { decode, encode } from '@temporalio/common/lib/encoding';
import { ConfigDataSource, LoadClientConfigOptions, LoadClientProfileOptions } from './types';

export function normalizeGrpcMetaKey(key: string): string {
  return key.toLocaleLowerCase().replace('_', '-');
}

/**
 * Raw TOML structure representing the client configuration file.
 *
 * @internal
 * @experimental Environment configuration is new feature and subject to change.
 */
export interface TomlClientConfig {
  profile: Record<string, TomlClientConfigProfile>;
}

/**
 * Raw TOML structure for a client configuration profile.
 * Note: field names use snake_case to match TOML file fields for correct parser deserialization.
 *
 * @internal
 * @experimental Environment configuration is new feature and subject to change.
 */
export interface TomlClientConfigProfile {
  address?: string;
  namespace?: string;
  api_key?: string;
  tls?: TomlClientConfigTLS;
  codec?: TomlClientConfigCodec;
  grpc_meta?: Record<string, string>;
}

/**
 * Raw TOML structure for client configuration TLS.
 *
 * @internal
 * @experimental Environment configuration is new feature and subject to change.
 */
export interface TomlClientConfigTLS {
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

/**
 * Raw TOML structure for client configuration codec.
 *
 * @internal
 * @experimental Environment configuration is new feature and subject to change.
 */
export interface TomlClientConfigCodec {
  endpoint?: string;
  auth?: string;
}

function sourceToStringData(source: ConfigDataSource | undefined): string | undefined {
  if (source === undefined) {
    return undefined;
  }
  if ('path' in source) {
    return readFileSync(source.path, { encoding: 'utf-8' });
  }

  if (typeof source.data === 'string') {
    return source.data;
  }

  return decode(source.data);
}

export function tomlLoadClientConfig(options: LoadClientConfigOptions): TomlClientConfig {
  const envProvider: Record<string, string | undefined> = options.overrideEnvVars ?? process.env;

  let configData = undefined;
  try {
    configData = sourceToStringData(options.configSource) ?? getFallbackConfigData(envProvider);
  } catch (error) {
    const isFileNotFound = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    if (!isFileNotFound) {
      throw error;
    }
    // File not found is ok
  }
  if (configData !== undefined) {
    return loadFromTomlData(configData, options.configFileStrict ?? false);
  }
  return { profile: {} }; // default ClientConfig
}

export function loadFromTomlData(tomlData: string, isStrict: boolean): TomlClientConfig {
  const parsed = parse(tomlData);
  if (isStrict) {
    strictValidateTomlStructure(parsed);
  }

  return parsed as unknown as TomlClientConfig;
}

export function configToTomlData(config: TomlClientConfig): Uint8Array {
  return encode(stringify(config));
}

function strictValidateTomlStructure(parsed: TomlTable): void {
  const allowedTopLevel = new Set(['profile']);
  const allowedProfile = new Set(['address', 'namespace', 'api_key', 'tls', 'codec', 'grpc_meta']);
  const allowedTLS = new Set([
    'disabled',
    'client_cert_path',
    'client_key_path',
    'client_cert_data',
    'client_key_data',
    'server_ca_cert_path',
    'server_ca_cert_data',
    'server_name',
  ]);
  const allowedCodec = new Set(['endpoint', 'auth']);

  // Check top-level keys
  const unknownTopLevel = Object.keys(parsed).filter((k) => !allowedTopLevel.has(k));
  if (unknownTopLevel.length > 0) {
    throw new Error(`Validation error: key(s) unrecognized: ${unknownTopLevel.join(', ')}`);
  }

  const profiles = parsed.profile;
  if (profiles === undefined) return;

  // Ensure it's a TomlTable (not a primitive or array)
  if (typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error('Validation error: profile must be a table');
  }

  for (const [profileName, profileData] of Object.entries(profiles)) {
    // Ensure profile is a table
    if (typeof profileData !== 'object' || Array.isArray(profileData)) {
      throw new Error(`Validation error: profile.${profileName} must be a table`);
    }

    const unknownProfile = Object.keys(profileData).filter((k) => !allowedProfile.has(k));
    if (unknownProfile.length > 0) {
      throw new Error(`Validation error: key(s) unrecognized in profile.${profileName}: ${unknownProfile.join(', ')}`);
    }

    // Validate TLS
    const tls = profileData.tls;
    if (tls !== undefined) {
      if (typeof tls !== 'object' || Array.isArray(tls)) {
        throw new Error(`Validation error: profile.${profileName}.tls must be a table`);
      }
      const unknownTLS = Object.keys(tls).filter((k) => !allowedTLS.has(k));
      if (unknownTLS.length > 0) {
        throw new Error(
          `Validation error: key(s) unrecognized in profile.${profileName}.tls: ${unknownTLS.join(', ')}`
        );
      }
    }

    // Validate codec
    const codec = profileData.codec;
    if (codec !== undefined) {
      if (typeof codec !== 'object' || Array.isArray(codec)) {
        throw new Error(`Validation error: profile.${profileName}.codec must be a table`);
      }
      const unknownCodec = Object.keys(codec).filter((k) => !allowedCodec.has(k));
      if (unknownCodec.length > 0) {
        throw new Error(
          `Validation error: key(s) unrecognized in profile.${profileName}.codec: ${unknownCodec.join(', ')}`
        );
      }
    }
  }
}

function getFallbackConfigData(envProvider: Record<string, string | undefined>): string | undefined {
  // configSource was not set - fallback to TEMPORAL_CONFIG_FILE, then the default file path
  let filePath = envProvider['TEMPORAL_CONFIG_FILE'];
  if (filePath === undefined) {
    filePath = getDefaultConfigFilePath();
  }
  return readFileSync(filePath, { encoding: 'utf-8' });
}

export function tomlLoadClientConfigProfile(options: LoadClientProfileOptions): TomlClientConfigProfile {
  if (options.disableEnv && options.disableFile) {
    throw new Error('Cannot disable both file and environment loading');
  }

  const envProvider: Record<string, string | undefined> = options.overrideEnvVars ?? process.env;

  let profile: TomlClientConfigProfile = {};

  if (!options.disableFile) {
    const tomlClientConfig = tomlLoadClientConfig({
      configSource: options.configSource,
      configFileStrict: options.configFileStrict,
      overrideEnvVars: options.overrideEnvVars,
    });
    // If profile name not provided, fallback to env variable.
    const profileName = options.profile ?? envProvider['TEMPORAL_PROFILE'];
    // If env var also not provided, fallback to default profile name.
    const tomlProfile = tomlClientConfig.profile[profileName ?? DEFAULT_CONFIG_FILE_PROFILE];
    // If toml profile does not exist and an explicit profile was requested, error.
    if (tomlProfile === undefined && profileName) {
      throw new Error(`Profile '${profileName}' not found in config data`);
    }
    // Use loaded profile if exists, otherwise fallback to default profile.
    profile = tomlProfile ?? {};
  }

  if (!options.disableEnv) {
    applyProfileEnvVars(profile, envProvider);
  }
  return profile;
}

function applyProfileEnvVars(profile: TomlClientConfigProfile, envProvider: Record<string, string | undefined>) {
  profile.address = envProvider['TEMPORAL_ADDRESS'] ?? profile.address;
  profile.namespace = envProvider['TEMPORAL_NAMESPACE'] ?? profile.namespace;
  profile.api_key = envProvider['TEMPORAL_API_KEY'] ?? profile.api_key;
  const tlsFromEnv = getTLSFromEnvVars(envProvider);
  profile.tls = profile.tls || tlsFromEnv ? { ...profile.tls, ...tlsFromEnv } : undefined;
  const codecFromEnv = getCodecFromEnvVars(envProvider);
  profile.codec = profile.codec || codecFromEnv ? { ...profile.codec, ...codecFromEnv } : undefined;
  applyGrpcMetaFromEnvVars(profile, envProvider);
}

function getTLSFromEnvVars(envProvider: Record<string, string | undefined>): TomlClientConfigTLS | undefined {
  const tlsConfig: TomlClientConfigTLS = filterNullAndUndefined({
    disabled: envVarToBool(envProvider['TEMPORAL_TLS']),
    client_cert_path: envProvider['TEMPORAL_TLS_CLIENT_CERT_PATH'],
    client_cert_data: envProvider['TEMPORAL_TLS_CLIENT_CERT_DATA'],
    client_key_path: envProvider['TEMPORAL_TLS_CLIENT_KEY_PATH'],
    client_key_data: envProvider['TEMPORAL_TLS_CLIENT_KEY_DATA'],
    server_ca_cert_path: envProvider['TEMPORAL_TLS_SERVER_CA_CERT_PATH'],
    server_ca_cert_data: envProvider['TEMPORAL_TLS_SERVER_CA_CERT_DATA'],
    server_name: envProvider['TEMPORAL_TLS_SERVER_NAME'],
    disable_host_verification: envVarToBool(envProvider['TEMPORAL_TLS_DISABLE_HOST_VERIFICATION']),
  });

  // If no properties were added, return undefined
  return Object.keys(tlsConfig).length > 0 ? tlsConfig : undefined;
}

function getCodecFromEnvVars(envProvider: Record<string, string | undefined>): TomlClientConfigCodec | undefined {
  const codec: TomlClientConfigCodec = {};
  const endpoint = envProvider['TEMPORAL_CODEC_ENDPOINT'];
  if (endpoint !== undefined) {
    codec.endpoint = endpoint;
  }
  const auth = envProvider['TEMPORAL_CODEC_AUTH'];
  if (auth !== undefined) {
    codec.auth = auth;
  }
  // If no properties were added, return undefined
  return Object.keys(codec).length > 0 ? codec : undefined;
}

function applyGrpcMetaFromEnvVars(profile: TomlClientConfigProfile, envProvider: Record<string, string | undefined>) {
  const PREFIX = 'TEMPORAL_GRPC_META_';

  for (const [key, value] of Object.entries(envProvider)) {
    if (key.startsWith(PREFIX)) {
      const headerName = key.slice(PREFIX.length);
      const normalizedKey = normalizeGrpcMetaKey(headerName);
      if (profile.grpc_meta === undefined) {
        profile.grpc_meta = {};
      }

      // Empty values remove the key, non-empty values set it
      if (value === '' || value == null) {
        delete profile.grpc_meta[normalizedKey];
      } else {
        profile.grpc_meta[normalizedKey] = value;
      }
    }
  }
}

function envVarToBool(envVar?: string): boolean | undefined {
  if (envVar === undefined) {
    return undefined;
  }
  return envVar === '1' || envVar === 'true';
}

const DEFAULT_CONFIG_FILE_PROFILE = 'default';
const DEFAULT_CONFIG_FILE = 'temporal.toml';

function getDefaultConfigFilePath(): string {
  const configDir = getUserConfigDir();
  const configPath = path.join(configDir, 'temporalio', DEFAULT_CONFIG_FILE);
  return configPath;
}

function getUserConfigDir(): string {
  const platform = os.platform();

  switch (platform) {
    case 'win32': {
      const dir = process.env.APPDATA;
      if (!dir) {
        throw new Error('%AppData% is not defined');
      }
      return dir;
    }

    case 'darwin': {
      const dir = process.env.HOME;
      if (!dir) {
        throw new Error('$HOME is not defined');
      }
      return path.join(dir, 'Library', 'Application Support');
    }

    default: {
      // Unix/Linux
      let dir = process.env.XDG_CONFIG_HOME;
      if (!dir) {
        const home = process.env.HOME;
        if (!home) {
          throw new Error('neither $XDG_CONFIG_HOME nor $HOME are defined');
        }
        dir = path.join(home, '.config');
      } else if (!path.isAbsolute(dir)) {
        throw new Error('path in $XDG_CONFIG_HOME is relative');
      }
      return dir;
    }
  }
}
