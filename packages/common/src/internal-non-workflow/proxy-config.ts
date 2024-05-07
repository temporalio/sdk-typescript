import { ProtoHostPort, splitProtoHostPort } from './parse-host-uri';

/**
 * Configuration for HTTP CONNECT proxying.
 */
export interface HttpConnectProxyConfig {
  type: 'http-connect';

  /**
   * Target host:port for the HTTP CONNECT proxy.
   */
  targetHost: string;

  /**
   * Basic auth for the HTTP CONNECT proxy, if any.
   */
  basicAuth?: {
    username: string;
    password: string;
  };
}

export type ProxyConfig = HttpConnectProxyConfig;

/**
 * Parse the address of a HTTP CONNECT proxy endpoint.
 *
 * - The URI may only contain a scheme, a hostname, and a port;
 * - If specified, scheme must be 'http';
 * - Port is required.
 *
 * Examples of valid URIs:
 *
 * ```
 * 127.0.0.1:8080 => { scheme: 'http', host: '192.168.0.1', port: 8080 }
 * my.temporal.service.com:8888 => { scheme: 'http', host: 'my.temporal.service.com', port: 8888 }
 * [::ffff:192.0.2.128]:8080 => { scheme: 'http', host: '::ffff:192.0.2.128', port: 8080 }
 * ```
 */
export function parseHttpConnectProxyAddress(target: string): ProtoHostPort {
  const match = splitProtoHostPort(target);
  if (!match)
    throw new TypeError(
      `Invalid address for HTTP CONNECT proxy: expected 'hostname:port' or '[ipv6 address]:port'; got '${target}'`
    );
  const { scheme = 'http', hostname: host, port } = match;
  if (scheme !== 'http')
    throw new TypeError(`Invalid address for HTTP CONNECT proxy: scheme must be http'; got '${target}'`);
  if (port === undefined)
    throw new TypeError(`Invalid address for HTTP CONNECT proxy: port is required; got '${target}'`);
  return { scheme, hostname: host, port };
}
