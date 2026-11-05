import type { TLSConfig } from '@temporalio/common/internal/internal-non-workflow';
import { decode } from '@temporalio/common/internal/internal-workflow';
import {
  configToTomlData,
  loadFromTomlData,
  tomlLoadClientConfig,
  tomlLoadClientConfigProfile,
} from './envconfig-toml';
import type {
  ClientConfig,
  ClientConfigExtension,
  ClientConfigExtensionPlugin,
  ClientConfigExtensionRequest,
  ClientConfigFromTomlOptions,
  ClientConfigProfile,
  ClientConfigTLS,
  ClientConnectConfig,
  LoadClientConfigOptions,
  LoadClientConnectConfigOptions,
  LoadClientProfileOptions,
} from './types';
import { fromTomlConfig, fromTomlProfile, loadConfigData, toTomlConfig } from './utils';

export function loadClientConfig(options: LoadClientConfigOptions): ClientConfig {
  return fromTomlConfig(tomlLoadClientConfig(options));
}

export function loadClientConfigFromToml(tomlData: Uint8Array, options: ClientConfigFromTomlOptions): ClientConfig {
  return fromTomlConfig(loadFromTomlData(decode(tomlData), options.strict));
}

export function clientConfigToToml(config: ClientConfig): Uint8Array {
  return configToTomlData(toTomlConfig(config));
}

export function loadClientConfigProfile(options: LoadClientProfileOptions = {}): ClientConfigProfile {
  return fromTomlProfile(tomlLoadClientConfigProfile(options));
}

/**
 * Loads a client configuration profile and converts it to connection options, then applies any
 * {@link LoadClientConnectConfigOptions.extensions}. This is effectively a shortcut for
 * {@link loadClientConfigProfile} + {@link toClientOptions}, plus extensions.
 */
export function loadClientConnectConfig(options: LoadClientConnectConfigOptions = {}): ClientConnectConfig {
  const { extensions, ...profileOptions } = options;
  validateExtensions(extensions ?? []);

  const profile = loadClientConfigProfile(profileOptions);
  const config = toClientOptions(profile);

  if (extensions?.length) {
    const request: ClientConfigExtensionRequest = {
      profile,
      env: options.disableEnv ? undefined : (options.overrideEnvVars ?? process.env),
    };
    const plugins: ClientConfigExtensionPlugin[] = [];
    for (const extension of extensions) {
      let plugin: ClientConfigExtensionPlugin | undefined;
      try {
        plugin = extension.clientPlugin(request);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`client config extension "${extension.name}": ${message}`, { cause: err });
      }
      if (plugin !== undefined) {
        plugins.push(plugin);
      }
    }
    if (plugins.length > 0) {
      config.connectionOptions.plugins = plugins;
    }
  }
  return config;
}

function validateExtensions(extensions: ClientConfigExtension[]): void {
  const seen = new Set<string>();
  extensions.forEach((extension, i) => {
    if (extension == null) {
      throw new Error(`client config extension at index ${i} is ${extension}`);
    }
    const name = extension.name;
    if (!name) {
      throw new Error(`client config extension at index ${i} has empty name`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate client config extension name "${name}"`);
    }
    seen.add(name);
  });
}

export function toClientOptions(profile: ClientConfigProfile): ClientConnectConfig {
  // TLS is enabled if we have an explicit TLS config, or if an api key is provided.
  const tls = toTLSConfig(profile.tls) ?? (profile.apiKey !== undefined ? true : undefined);
  return {
    namespace: profile.namespace,
    connectionOptions: {
      address: profile.address,
      apiKey: profile.apiKey,
      tls,
      metadata: profile.grpcMeta,
    },
  };
}

export function toTLSConfig(config?: ClientConfigTLS): TLSConfig | boolean | undefined {
  if (config === undefined) {
    return undefined;
  }
  if (config.disabled === true) {
    return false;
  }

  const serverRootCACert = loadConfigData(config.serverCACert);
  const crtBuffer = loadConfigData(config.clientCert);
  const keyBuffer = loadConfigData(config.clientKey);

  const tlsConfig: TLSConfig = {
    serverNameOverride: config.serverName,
    serverRootCACertificate: serverRootCACert,
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
