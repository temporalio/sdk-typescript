import * as fs from 'fs';
import { filterNullAndUndefined } from '@temporalio/common/lib/internal-workflow';
import {
  ClientConfigProfile,
  ClientConfigTLS,
  ClientConfig,
  tomlClientConfigProfile,
  tomlClientConfigTLS,
  tomlClientConfig,
  ConfigDataSource,
} from './types';

export function loadConfigData(source?: ConfigDataSource): Buffer | undefined {
  if (!source) return undefined;

  if ('path' in source) {
    return readPathSync(source.path);
  }

  return Buffer.isBuffer(source.data) ? source.data : Buffer.from(source.data);
}

export function readPathSync(path?: string): Buffer | undefined {
  if (path === undefined) {
    return undefined;
  }

  return fs.readFileSync(path);
}

export function normalizeGrpcMetaKey(key: string): string {
  return key.toLocaleLowerCase().replace('_', '-');
}

export function fromTomlProfile(tomlProfile: tomlClientConfigProfile): ClientConfigProfile {
  let grpcMeta: Record<string, string> | undefined = undefined;
  if (tomlProfile.grpc_meta !== undefined) {
    grpcMeta = {};
    // Normalize GRPC meta keys.
    for (const key in tomlProfile.grpc_meta) {
      grpcMeta[normalizeGrpcMetaKey(key)] = tomlProfile.grpc_meta[key];
    }
  }
  const profile: ClientConfigProfile = {
    address: tomlProfile.address,
    namespace: tomlProfile.namespace,
    apiKey: tomlProfile.api_key,
    tls: fromTomlTLS(tomlProfile.tls),
    grpcMeta,
  };
  return filterNullAndUndefined(profile);
}

export function toTomlProfile(profile: ClientConfigProfile): tomlClientConfigProfile {
  let grpc_meta: Record<string, string> | undefined = undefined;
  if (profile.grpcMeta !== undefined) {
    grpc_meta = {};
    // Normalize GRPC meta keys.
    for (const key in profile.grpcMeta) {
      grpc_meta[normalizeGrpcMetaKey(key)] = profile.grpcMeta[key];
    }
  }
  const tomlProfile = {
    address: profile.address,
    namespace: profile.namespace,
    api_key: profile.apiKey,
    tls: toTomlTLS(profile.tls),
    grpc_meta,
  };
  return filterNullAndUndefined(tomlProfile);
}

export function fromTomlTLS(tomlTLS?: tomlClientConfigTLS): ClientConfigTLS | undefined {
  if (tomlTLS === undefined) {
    return undefined;
  }
  const clientConfigTLS: ClientConfigTLS = {
    disabled: tomlTLS.disabled,
    serverName: tomlTLS.server_name,
    clientCert: toConfigDataSource(tomlTLS.client_cert_path, tomlTLS.client_cert_data, 'client_cert'),
    clientKey: toConfigDataSource(tomlTLS.client_key_path, tomlTLS.client_key_data, 'client_key'),
    serverCACert: toConfigDataSource(tomlTLS.server_ca_cert_path, tomlTLS.server_ca_cert_data, 'server_ca_cert'),
  };
  return filterNullAndUndefined(clientConfigTLS);
}

export function toTomlTLS(tlsConfig?: ClientConfigTLS): tomlClientConfigTLS | undefined {
  if (tlsConfig === undefined) {
    return undefined;
  }
  const clientCert = toPathAndData(tlsConfig.clientCert);
  const clientKey = toPathAndData(tlsConfig.clientKey);
  const serverCACert = toPathAndData(tlsConfig.serverCACert);
  const tomlConfigTLS = {
    disabled: tlsConfig.disabled,
    server_name: tlsConfig.serverName,
    client_cert_path: clientCert?.path,
    client_cert_data: clientCert?.data?.toString() ?? undefined,
    client_key_path: clientKey?.path,
    client_key_data: clientKey?.data?.toString(),
    server_ca_cert_path: serverCACert?.path,
    server_ca_cert_data: serverCACert?.data?.toString(),
  };
  return filterNullAndUndefined(tomlConfigTLS);
}

export function fromTomlConfig(tomlConfig: tomlClientConfig): ClientConfig {
  const profiles: Record<string, ClientConfigProfile> = {};

  for (const [profileName, profile] of Object.entries(tomlConfig.profile)) {
    profiles[profileName] = fromTomlProfile(profile);
  }

  return { profiles };
}

export function toTomlConfig(config: ClientConfig): tomlClientConfig {
  const profile: Record<string, tomlClientConfigProfile> = {};

  for (const [profileName, configProfile] of Object.entries(config.profiles)) {
    profile[profileName] = toTomlProfile(configProfile);
  }

  return { profile };
}

export function toPathAndData(source?: ConfigDataSource): { path?: string; data?: Buffer } | undefined {
  if (source === undefined) {
    return undefined;
  }
  if ('path' in source) {
    return { path: source.path };
  }
  if (Buffer.isBuffer(source.data)) {
    return { data: source.data };
  }
  return { data: Buffer.from(source.data, 'utf8') };
}

export function toConfigDataSource(
  path: string | undefined,
  data: string | undefined,
  fieldName: string
): ConfigDataSource | undefined {
  if (path !== undefined && data !== undefined) {
    throw new Error(`Cannot specify both ${fieldName}_path and ${fieldName}_data`);
  }
  if (data !== undefined) {
    return { data: Buffer.from(data) };
  }
  if (path !== undefined) {
    return { path };
  }
  return undefined;
}
