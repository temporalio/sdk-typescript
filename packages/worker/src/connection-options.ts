import { native } from '@temporalio/core-bridge';
import {
  joinProtoHostPort,
  normalizeGrpcEndpointAddress,
  normalizeTlsConfig,
  parseHttpConnectProxyAddress,
  ProxyConfig,
  TLSConfig,
} from '@temporalio/common/lib/internal-non-workflow';
import type { Metadata } from '@temporalio/client';
import pkg from './pkg';
import type { NativeConnectionPlugin } from './connection';

export { TLSConfig, ProxyConfig };

/**
 * The default Temporal Server's TCP port for public gRPC connections.
 */
const DEFAULT_TEMPORAL_GRPC_PORT = 7233;

export interface NativeConnectionOptions {
  /**
   * The address of the Temporal server to connect to, in `hostname:port` format.
   *
   * Port defaults to 7233. Raw IPv6 addresses must be wrapped in square brackets (e.g. `[ipv6]:port`).
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
   */
  proxy?: ProxyConfig;

  /**
   * Optional mapping of gRPC metadata (HTTP headers) to send with each request to the server.
   *
   * Set statically at connection time, can be replaced later using {@link NativeConnection.setMetadata}.
   */
  metadata?: Metadata;

  /**
   * API key for Temporal. This becomes the "Authorization" HTTP header with "Bearer " prepended.
   * This is only set if RPC metadata doesn't already have an "authorization" key.
   */
  apiKey?: string;

  /**
   * If set to true, error code labels will not be included on request failure
   * metrics emitted by this Client.
   *
   * @default false
   */
  disableErrorCodeMetricTags?: boolean;

  /**
   * List of plugins to register with the native connection.
   *
   * Plugins allow you to configure the native connection options.
   *
   * Any plugins provided will also be passed to any Worker, Client, or Bundler built from this connection.
   *
   * @experimental Plugins is an experimental feature; APIs may change without notice.
   */
  plugins?: NativeConnectionPlugin[];
}

// Compile to Native ///////////////////////////////////////////////////////////////////////////////

export function toNativeClientOptions(options: NativeConnectionOptions): native.ClientOptions {
  const address = normalizeGrpcEndpointAddress(options.address ?? 'localhost:7233', DEFAULT_TEMPORAL_GRPC_PORT);

  const tlsInput = normalizeTlsConfig(options.tls, options.apiKey);
  const tls: native.TlsOptions | null = tlsInput
    ? {
        domain: tlsInput.serverNameOverride ?? null,
        serverRootCaCert: tlsInput.serverRootCACertificate ? Buffer.from(tlsInput.serverRootCACertificate) : null,
        clientTlsOptions: tlsInput.clientCertPair
          ? {
              clientCert: tlsInput.clientCertPair.crt && Buffer.from(tlsInput.clientCertPair.crt),
              clientPrivateKey: tlsInput.clientCertPair.key && Buffer.from(tlsInput.clientCertPair.key),
            }
          : null,
      }
    : null;

  let httpConnectProxy: native.HttpConnectProxy | null = null;
  if (options.proxy?.targetHost) {
    const { targetHost: target } = options.proxy;
    const { hostname: host, port } = parseHttpConnectProxyAddress(target);
    const basicAuth = options.proxy.basicAuth
      ? {
          username: options.proxy.basicAuth.username,
          password: options.proxy.basicAuth.password,
        }
      : null;
    httpConnectProxy = {
      targetHost: joinProtoHostPort({ hostname: host, port }),
      basicAuth,
    };
  }

  if (options?.apiKey && options.metadata?.['Authorization']) {
    throw new TypeError(
      'Both `apiKey` option and `Authorization` header were provided. Only one makes sense to use at a time.'
    );
  }

  let headers: Record<string, native.MetadataValue> | null = null;
  if (options.metadata) {
    headers = {};
    for (const [key, value] of Object.entries(options.metadata)) {
      if (typeof value === 'string') {
        headers[key] = { type: 'ascii', value };
      } else {
        headers[key] = { type: 'binary', value };
      }
    }
  }

  return {
    targetUrl: tls ? `https://${address}` : `http://${address}`,
    clientName: 'temporal-typescript',
    clientVersion: pkg.version,
    tls,
    httpConnectProxy,
    headers,
    apiKey: options.apiKey ?? null,
    disableErrorCodeMetricTags: options.disableErrorCodeMetricTags ?? false,
  };
}
