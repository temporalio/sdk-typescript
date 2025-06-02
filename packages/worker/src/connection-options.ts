import { native } from '@temporalio/core-bridge';
import {
  joinProtoHostPort,
  normalizeGrpcEndpointAddress,
  normalizeTlsConfig,
  parseHttpConnectProxyAddress,
  ProxyConfig,
  TLSConfig,
} from '@temporalio/common/lib/internal-non-workflow';
import pkg from './pkg';

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
  metadata?: Record<string, string>;

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
}

// Compile to Native ///////////////////////////////////////////////////////////////////////////////

export function toNativeClientOptions(options: NativeConnectionOptions): native.ClientOptions {
  const address = normalizeGrpcEndpointAddress(options.address ?? 'localhost:7233', DEFAULT_TEMPORAL_GRPC_PORT);

  const tlsInput = normalizeTlsConfig(options.tls);
  const tls: native.TLSConfig | null = tlsInput
    ? {
        domain: tlsInput.serverNameOverride ?? null,
        serverRootCaCert: tlsInput.serverRootCACertificate ?? null,
        clientTlsConfig: tlsInput.clientCertPair
          ? {
              clientCert: tlsInput.clientCertPair.crt,
              clientPrivateKey: tlsInput.clientCertPair.key,
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

  return {
    targetUrl: tls ? `https://${address}` : `http://${address}`,
    clientName: 'temporal-typescript',
    clientVersion: pkg.version,
    tls,
    httpConnectProxy,
    headers: options.metadata ?? null,
    apiKey: options.apiKey ?? null,
    disableErrorCodeMetricTags: options.disableErrorCodeMetricTags ?? false,
  };
}
