import * as path from 'path';
import * as os from 'os';
import { parse, stringify, TomlTable } from 'smol-toml';
import {
  ConfigDataSource,
  LoadClientConfigOptions,
  LoadClientProfileOptions,
  tomlClientConfig,
  tomlClientConfigCodec,
  tomlClientConfigProfile,
  tomlClientConfigTLS,
} from './types';
import { normalizeGrpcMetaKey, readPathSync } from './utils';

function sourceToStringData(source?: ConfigDataSource): string | undefined {
  if (source === undefined) {
    return undefined;
  }
  if ('path' in source) {
    return readPathSync(source.path)?.toString();
  }

  if (Buffer.isBuffer(source.data)) {
    return source.data.toString();
  }
  return source.data;
}

type EnvProvider = { kind: 'Map'; map: Record<string, string> } | { kind: 'System' };

function getEnvVar(provider: EnvProvider, key: string): string | undefined {
  if (provider.kind === 'Map') {
    return provider.map[key];
  }
  return process.env[key];
}

export function tomlLoadClientConfig(options: LoadClientConfigOptions): tomlClientConfig {
  const envProvider: EnvProvider = options.overrideEnvVars
    ? { kind: 'Map', map: options.overrideEnvVars }
    : { kind: 'System' };

  let configData = undefined;
  try {
    configData = sourceToStringData(options.configSource) ?? getFallbackConfigData(envProvider);
  } catch (error) {
    const isFileNotFound = error instanceof Error && 'code' in error && error.code === 'ENOENT';
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

export function loadFromTomlData(tomlData: string, isStrict: boolean): tomlClientConfig {
  const parsed = parse(tomlData);
  if (isStrict) {
    strictValidateTomlStructure(parsed);
  }

  return parsed as unknown as tomlClientConfig;
}

export function configToTomlData(config: tomlClientConfig): Buffer {
  return Buffer.from(stringify(config), 'utf-8');
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

function getFallbackConfigData(envProvider: EnvProvider): string | undefined {
  // configSource was not set - fallback to TEMPORAL_CONFIG_FILE, then the default file path
  let filePath = getEnvVar(envProvider, 'TEMPORAL_CONFIG_FILE');
  if (filePath === undefined) {
    filePath = getDefaultConfigFilePath();
  }
  return readPathSync(filePath)?.toString();
}

export function tomlLoadClientConfigProfile(options: LoadClientProfileOptions): tomlClientConfigProfile {
  if (options.disableEnv && options.disableFile) {
    throw new Error('Cannot disable both file and environment loading');
  }

  const envProvider: EnvProvider = options.overrideEnvVars
    ? { kind: 'Map', map: options.overrideEnvVars }
    : { kind: 'System' };

  let profile: tomlClientConfigProfile = {};

  if (!options.disableFile) {
    const tomlClientConfig = tomlLoadClientConfig({
      configSource: options.configSource,
      configFileStrict: options.configFileStrict,
      overrideEnvVars: options.overrideEnvVars,
    });
    let profileName = options.profile;
    let profileSet = true;
    // If profile name not provided, fallback to env variable.
    if (profileName === undefined) {
      profileName = getEnvVar(envProvider, 'TEMPORAL_PROFILE');
    }
    // If env var also not provided, fallback to default profile name.
    if (profileName === undefined) {
      profileName = DEFAULT_CONFIG_FILE_PROFILE;
      profileSet = false;
    }
    const tomlProfile = tomlClientConfig.profile[profileName];
    // If toml profile does not exist and an explicit profile was requested, error.
    if (tomlProfile === undefined && profileSet) {
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

function applyProfileEnvVars(profile: tomlClientConfigProfile, envProvider: EnvProvider) {
  profile.address = getEnvVar(envProvider, 'TEMPORAL_ADDRESS') ?? profile.address;
  profile.namespace = getEnvVar(envProvider, 'TEMPORAL_NAMESPACE') ?? profile.namespace;
  profile.api_key = getEnvVar(envProvider, 'TEMPORAL_API_KEY') ?? profile.api_key;
  const tlsFromEnv = getTLSFromEnvVars(envProvider);
  profile.tls = profile.tls || tlsFromEnv ? { ...profile.tls, ...tlsFromEnv } : undefined;
  const codecFromEnv = getCodecFromEnvVars(envProvider);
  profile.codec = profile.codec || codecFromEnv ? { ...profile.codec, ...codecFromEnv } : undefined;
  applyGrpcMetaFromEnvVars(profile, envProvider);
}

function getTLSFromEnvVars(envProvider: EnvProvider): tomlClientConfigTLS | undefined {
  const tlsConfig: tomlClientConfigTLS = {};
  const tlsEnvVar = getEnvVar(envProvider, 'TEMPORAL_TLS');
  if (tlsEnvVar !== undefined) {
    tlsConfig.disabled = envVarToBool(tlsEnvVar);
  }
  const clientCertPath = getEnvVar(envProvider, 'TEMPORAL_TLS_CLIENT_CERT_PATH');
  if (clientCertPath !== undefined) {
    tlsConfig.client_cert_path = clientCertPath;
  }
  const clientCertData = getEnvVar(envProvider, 'TEMPORAL_TLS_CLIENT_CERT_DATA');
  if (clientCertData !== undefined) {
    tlsConfig.client_cert_data = clientCertData;
  }
  const clientKeyPath = getEnvVar(envProvider, 'TEMPORAL_TLS_CLIENT_KEY_PATH');
  if (clientKeyPath !== undefined) {
    tlsConfig.client_key_path = clientKeyPath;
  }
  const clientKeyData = getEnvVar(envProvider, 'TEMPORAL_TLS_CLIENT_KEY_DATA');
  if (clientKeyData !== undefined) {
    tlsConfig.client_key_data = clientKeyData;
  }
  const serverCertPath = getEnvVar(envProvider, 'TEMPORAL_TLS_SERVER_CA_CERT_PATH');
  if (serverCertPath !== undefined) {
    tlsConfig.server_ca_cert_path = serverCertPath;
  }
  const serverCertData = getEnvVar(envProvider, 'TEMPORAL_TLS_SERVER_CA_CERT_DATA');
  if (serverCertData !== undefined) {
    tlsConfig.server_ca_cert_data = serverCertData;
  }
  const serverName = getEnvVar(envProvider, 'TEMPORAL_TLS_SERVER_NAME');
  if (serverName !== undefined) {
    tlsConfig.server_name = serverName;
  }
  const disableHostVerification = getEnvVar(envProvider, 'TEMPORAL_TLS_DISABLE_HOST_VERIFICATION');
  if (disableHostVerification !== undefined) {
    tlsConfig.disable_host_verification = envVarToBool(disableHostVerification);
  }
  // If no properties were added, return undefined
  return Object.keys(tlsConfig).length > 0 ? tlsConfig : undefined;
}

function getCodecFromEnvVars(envProvider: EnvProvider): tomlClientConfigCodec | undefined {
  const codec: tomlClientConfigCodec = {};
  const endpoint = getEnvVar(envProvider, 'TEMPORAL_CODEC_ENDPOINT');
  if (endpoint !== undefined) {
    codec.endpoint = endpoint;
  }
  const auth = getEnvVar(envProvider, 'TEMPORAL_CODEC_AUTH');
  if (auth !== undefined) {
    codec.auth = auth;
  }
  // If no properties were added, return undefined
  return Object.keys(codec).length > 0 ? codec : undefined;
}

function applyGrpcMetaFromEnvVars(profile: tomlClientConfigProfile, envProvider: EnvProvider) {
  const PREFIX = 'TEMPORAL_GRPC_META_';

  // Get key-value pairs based on provider type
  const envVars = envProvider.kind === 'Map' ? Object.entries(envProvider.map) : Object.entries(process.env);

  for (const [key, value] of envVars) {
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

function envVarToBool(envVar: string): boolean {
  return envVar === '1' || envVar === 'true';
}

const DEFAULT_CONFIG_FILE_PROFILE = 'default';
const DEFAULT_CONFIG_FILE = 'config.toml';

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
