import type { TLSConfig } from '@temporalio/common/lib/internal-non-workflow';
import { decode } from '@temporalio/common/lib/encoding';
import {
  configToTomlData,
  loadFromTomlData,
  tomlLoadClientConfig,
  tomlLoadClientConfigProfile,
} from './envconfig-toml';
import {
  ClientConfig,
  ClientConfigFromTomlOptions,
  ClientConfigProfile,
  ClientConfigTLS,
  ClientConnectConfig,
  LoadClientConfigOptions,
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

export function loadClientConnectConfig(options: LoadClientProfileOptions = {}): ClientConnectConfig {
  return toClientOptions(loadClientConfigProfile(options));
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
