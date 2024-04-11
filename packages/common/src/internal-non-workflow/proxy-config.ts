/** Configuration for HTTP CONNECT proxying. */
export interface HttpConnectProxyConfig {
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
