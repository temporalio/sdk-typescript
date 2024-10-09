/** TLS configuration options. */
export interface TLSConfig {
  /**
   * Overrides the target name (SNI) used for TLS host name checking.
   * If this attribute is not specified, the name used for TLS host name checking will be the host from {@link ServerOptions.url}.
   * This can be useful when you have reverse proxy in front of temporal server, and you may want to override the SNI to
   * direct traffic to the appropriate backend server based on custom routing rules. Oppositely, connections could be refused
   * if the provided SNI does not match the expected host. Adding this override should be done with care.
   */
  serverNameOverride?: string;
  /**
   * Root CA certificate used by the server. If not set, and the server's
   * cert is issued by someone the operating system trusts, verification will still work (ex: Cloud offering).
   */
  serverRootCACertificate?: Buffer;
  /** Sets the client certificate and key for connecting with mTLS */
  clientCertPair?: {
    /** The certificate for this client */
    crt: Buffer;
    /** The private key for this client */
    key: Buffer;
  };
}

/**
 * TLS configuration.
 * Pass a falsy value to use a non-encrypted connection or `true` or `{}` to
 * connect with TLS without any customization.
 */
export type TLSConfigOption = TLSConfig | boolean | undefined | null;

/**
 * Normalize {@link TLSConfigOption} by turning false and null to undefined and true to and empty object
 */
export function normalizeTlsConfig(tls: TLSConfigOption): TLSConfig | undefined {
  return typeof tls === 'object' ? (tls === null ? undefined : tls) : tls ? {} : undefined;
}
