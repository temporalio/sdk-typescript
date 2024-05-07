import * as native from '@temporalio/core-bridge';
import {
  normalizeTemporalGrpcEndpointAddress,
  joinProtoHostPort,
  parseHttpConnectProxyAddress,
} from '@temporalio/common/lib/internal-non-workflow';
import pkg from './pkg';

type TLSConfig = native.TLSConfig;
type ProxyConfig = native.ProxyConfig;

export { TLSConfig, ProxyConfig };

export interface NativeConnectionOptions {
  /**
   * The host and optional port of the Temporal server to connect to.
   * Port defaults to 7233 if address contains only host.
   *
   * @default localhost:7233
   */
  address?: string;

  /**
   * TLS configuration options.
   *
   * Pass a falsy value to use a non-encrypted connection or `true` or `{}` to
   * connect with TLS without any customization.
   */
  tls?: TLSConfig | boolean | null;

  /**
   * Proxying configuration.
   *
   * @experimental
   */
  proxy?: ProxyConfig;

  /**
   * Optional mapping of gRPC metadata (HTTP headers) to send with each request to the server.
   *
   * Set statically at connection time, can be replaced later using {@link NativeConnection.setMetadata}.
   */
  metadata?: Record<string, string>;

  /**
   * API key for Temporal. This becomes the "Authorization" HTTP header with "Bearer " prepended.
   * This is only set if RPC metadata doesn't already have an "authorization" key.
   */
  apiKey?: string;
}

export type RequiredNativeConnectionOptions = Omit<
  Required<NativeConnectionOptions>,
  'tls' | 'proxy' | 'metadata' | 'apiKey'
> & {
  tls?: NativeConnectionOptions['tls'];
  proxy?: NativeConnectionOptions['proxy'];
  metadata?: NativeConnectionOptions['metadata'];
  apiKey?: NativeConnectionOptions['apiKey'];
  sdkVersion: string;
};

export function getDefaultConnectionOptions(): RequiredNativeConnectionOptions {
  return {
    address: 'localhost:7233',
    sdkVersion: pkg.version,
  };
}

export function compileConnectionOptions(options: RequiredNativeConnectionOptions): RequiredNativeConnectionOptions {
  const { address, ...rest } = options;
  const proxyOpts: Partial<RequiredNativeConnectionOptions> = {};
  if (options.proxy?.targetHost) {
    const { targetHost: target, basicAuth } = options.proxy;
    const { hostname: host, port } = parseHttpConnectProxyAddress(target);
    proxyOpts.proxy = {
      type: 'http-connect',
      targetHost: joinProtoHostPort({ hostname: host, port }),
      basicAuth,
    };
  }
  return {
    ...rest,
    address: normalizeTemporalGrpcEndpointAddress(address),
    ...proxyOpts,
  };
}
