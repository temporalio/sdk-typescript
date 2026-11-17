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
  serverRootCACertificate?: Uint8Array;
  /**
   * Names to verify the server certificate against, instead of {@link serverNameOverride} or the
   * host from the connection address. The certificate is accepted if it is valid for any one of
   * these names.
   *
   * Use this when one address can route to servers that present different certificate names, for
   * example regional servers behind a global address, where each server's certificate names only
   * its own region. Unlike {@link serverNameOverride}, this does not change the SNI or HTTP/2
   * authority values.
   *
   * Requires {@link serverRootCACertificate}; the system root store is not consulted when this is
   * set. Must not be empty.
   */
  verificationServerNames?: string[];
  /** Sets the client certificate and key for connecting with mTLS */
  clientCertPair?: {
    /** The certificate for this client */
    crt: Uint8Array;
    /** The private key for this client */
    key: Uint8Array;
  };
}

/**
 * Validate {@link TLSConfig.verificationServerNames} and return them, or `undefined` when unset.
 *
 * @internal
 */
export function validateVerificationServerNames(tls: TLSConfig): string[] | undefined {
  const names = tls.verificationServerNames;
  if (names === undefined) {
    return undefined;
  }
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new TypeError('tls.verificationServerNames must be an array of strings');
  }
  if (names.length === 0) {
    throw new TypeError('tls.verificationServerNames must not be empty');
  }
  if (!tls.serverRootCACertificate) {
    throw new TypeError('tls.verificationServerNames requires tls.serverRootCACertificate to be set');
  }
  return [...names];
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
export function normalizeTlsConfig(
  tls: TLSConfigOption,
  apiKey?: string | (() => string) | undefined
): TLSConfig | undefined {
  tls = tls ?? (apiKey !== undefined ? true : undefined);
  return typeof tls === 'object' ? (tls === null ? undefined : tls) : tls ? {} : undefined;
}
