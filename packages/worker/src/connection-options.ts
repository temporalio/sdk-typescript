import os from 'os';
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
   * A human-readable string that can identify your worker
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;
  /**
   * A string that should be unique to the exact worker code/binary being executed
   * @default `@temporalio/worker` package name and version
   */
  workerBinaryId?: string;

  /**
   * TLS configuration options.
   *
   * Pass a falsy value to use a non-encrypted connection or `true` or `{}` to
   * connect with TLS without any customization.
   */
  tls?: TLSConfig | boolean | null;
}

export type RequiredNativeConnectionOptions = Omit<Required<NativeConnectionOptions>, 'tls'> & {
  tls?: NativeConnectionOptions['tls'];
  sdkVersion: string;
};

export function getDefaultConnectionOptions(): RequiredNativeConnectionOptions {
  return {
    address: 'localhost:7233',
    identity: `${process.pid}@${os.hostname()}`,
    workerBinaryId: `${pkg.name}@${pkg.version}`,
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
