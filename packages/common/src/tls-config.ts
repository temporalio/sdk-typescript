/** TLS configuration options. */
export interface TLSConfig {
  /**
   * Overrides the target name used for SSL host name checking.
   * If this attribute is not specified, the name used for SSL host name checking will be the host from {@link ServerOptions.url}.
   * This _should_ be used for testing only.
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
export type TLSConfigOption = TLSConfig | boolean | null;

/**
 * Normalize {@link TLSConfigOption} by turning false and null to undefined and true to and empty object
 */
export function normalizeTlsConfig(tls?: TLSConfigOption): TLSConfig | undefined {
  return typeof tls === 'object' ? (tls === null ? undefined : tls) : tls ? {} : undefined;
}
