/**
 * This file contain helper functions to parse specific subsets of URIs.
 *
 * The ECMAScript-compliant URL class don't properly handle some syntaxes that
 * we care about, such as not providing a protocol (e.g. '127.0.0.1:7233'), and
 * performs some normalizations that are not desirable for our use cases
 * (e.g. parsing 'http://127.0.0.1:7233' adds a '/' path). On the other side,
 * simply using `split(':')` breaks on IPv6 addresses. Hence these helpers.
 */

/**
 * Scheme. Requires but doesn't capture the ':' or '://' separator that follows.
 * e.g. `http:` will be captured as 'http'.
 */
const scheme = '(?:(?<scheme>[a-z][a-z0-9]+):(?:\\/\\/)?)';

/**
 * IPv4-style hostname. Not captured.
 * e.g.: `192.168.1.100`.
 */
const ipv4Hostname = '(?:\\d{1,3}(?:\\.\\d{1,3}){3})';

/**
 * IPv6-style hostname; must be enclosed in square brackets. Not captured.
 * e.g.: `[::1]`, `[2001:db8::1]`, `[::FFFF:129.144.52.38]`, etc.
 */
const ipv6Hostname = '(?:\\[(?<ipv6>[0-9a-fA-F.:]+)\\])';

// DNS-style hostname. Not captured.
// e.g.: `test.com` or `localhost`.
const dnsHostname = '(?:[^:/]+)';

const hostname = `(?:${ipv4Hostname}|${ipv6Hostname}|${dnsHostname})`;

// Port number. Requires but don't capture a preceeding ':' separator.
// For example, `:7233` will be captured as `7233`.
const port = '(?::(?<port>\\d+))';

const protoHostPortRegex = new RegExp(`^${scheme}??(?<hostname>${hostname})${port}?$`);

export interface ProtoHostPort {
  scheme?: string;
  hostname: string;
  port?: number;
}

/**
 * Split a URI composed only of a scheme, a hostname, and port.
 * The scheme and port are optional.
 *
 * Examples of valid URIs for HTTP CONNECT proxies:
 *
 * ```
 * http://test.com:8080 => { scheme: 'http', host: 'test.com', port: 8080 }
 * http://192.168.0.1:8080 => { scheme: 'http', host: '192.168.0.1', port: 8080 }
 * [::1]:8080 => { scheme: 'http', host: '::1', port: 8080 }
 * [::ffff:192.0.2.128]:8080 => { scheme: 'http', host: '::ffff:192.0.2.128', port: 8080 }
 * 192.168.0.1:8080 => { scheme: 'http', host: '192.168.0.1', port: 8080 }
 * ```
 */
export function splitProtoHostPort(uri: string): ProtoHostPort | undefined {
  const match = protoHostPortRegex.exec(uri);
  if (!match?.groups) return undefined;
  return {
    scheme: match.groups.scheme,
    hostname: match.groups.ipv6 ?? match.groups.hostname,
    port: match.groups.port !== undefined ? Number(match.groups.port) : undefined,
  };
}

export function joinProtoHostPort(components: ProtoHostPort): string {
  const { scheme, hostname, port } = components;
  const schemeText = scheme ? `${scheme}:` : '';
  const hostnameText = hostname.includes(':') ? `[${hostname}]` : hostname;
  const portText = port !== undefined ? `:${port}` : '';
  return `${schemeText}${hostnameText}${portText}`;
}

/**
 * Parse the address for the gRPC endpoint of a Temporal server.
 *
 * - The URI may only contain a hostname and a port.
 * - Port is optional; if not specified, set it to `defaultPort`.
 *
 * Examples of valid URIs (assuming `defaultPort` is 7233):
 *
 * ```
 * 127.0.0.1 => { host: '127.0.0.1', port: 7233 }
 * 192.168.0.1:7233 => { host: '192.168.0.1', port: 7233 }
 * my.temporal.service.com:7233 => { host: 'my.temporal.service.com', port: 7233 }
 * [::ffff:192.0.2.128]:8080 => { host: '[::ffff:192.0.2.128]', port: 8080 }
 * ```
 */
export function normalizeGrpcEndpointAddress(uri: string, defaultPort: number): string {
  const splitted = splitProtoHostPort(uri);
  if (!splitted || splitted.scheme !== undefined) {
    throw new TypeError(
      `Invalid address for Temporal gRPC endpoint: expected URI of the form 'hostname' or 'hostname:port'; got '${uri}'`
    );
  }
  splitted.port ??= defaultPort;
  return joinProtoHostPort(splitted);
}
