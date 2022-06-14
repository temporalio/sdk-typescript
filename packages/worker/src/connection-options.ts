import * as native from '@temporalio/core-bridge';
import pkg from './pkg';

type TLSConfig = native.TLSConfig;

export { TLSConfig };

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
   * HTTP headers to send with each gRPC request.
   *
   * Set statically at connection time, can be replaced later using {@link NativeConnection.setHeaders}.
   */
  headers?: Record<string, string>;
}

export type RequiredNativeConnectionOptions = Omit<Required<NativeConnectionOptions>, 'tls' | 'headers'> & {
  tls?: NativeConnectionOptions['tls'];
  headers?: NativeConnectionOptions['headers'];
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
  // eslint-disable-next-line prefer-const
  let [host, port] = address.split(':', 2);
  port = port || '7233';
  return { ...rest, address: `${host}:${port}` };
}
