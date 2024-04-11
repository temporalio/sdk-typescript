/** TLS configuration options. */
export interface ProxyConfig {
  /**
   * Overrides the target name (SNI) used for TLS host name checking.
   * If this attribute is not specified, the name used for TLS host name checking will be the host from {@link ServerOptions.url}.
   * This can be useful when you have reverse proxy in front of temporal server, and you may want to override the SNI to
   * direct traffic to the appropriate backend server based on custom routing rules. Oppositely, connections could be refused
   * if the provided SNI does not match the expected host. Adding this override should be done with care.
   */
  targetHost?: string;
  /** Sets the client certificate and key for connecting with mTLS */
  basicAuth?: {
    username: string,
    password: string,
  };
}

/**
 * TLS configuration.
 * Pass a falsy value to use a non-encrypted connection or `true` or `{}` to
 * connect with TLS without any customization.
 */
export type ProxyConfigOption = ProxyConfig | boolean | null;

/**
 * Normalize {@link ProxyConfigOption} by turning false and null to undefined and true to and empty object
 */
export function normalizeProxyConfig(proxy?: ProxyConfigOption): ProxyConfig | undefined {
  return typeof proxy === 'object' ? (proxy === null ? undefined : proxy) : proxy ? {} : undefined;
}
