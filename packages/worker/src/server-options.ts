import os from 'os';
import * as native from '@temporalio/core-bridge';
import pkg from './pkg';

type TLSConfig = native.TLSConfig;

export { TLSConfig };

export interface ServerOptions {
  /**
   * The host and optional port of the Temporal server to connect to.
   * Port defaults to 7233 if address contains only host.
   *
   * @default localhost:7233
   */
  address?: string;
  /**
   * What namespace will we operate under
   * @default default
   */
  namespace?: string;

  /**
   * A human-readable string that can identify your worker
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;
  /**
   * A string that should be unique to the exact worker code/binary being executed
   * @default `@temporal/worker` package name and version
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

export type RequiredServerOptions = Omit<Required<ServerOptions>, 'tls'> & {
  tls?: ServerOptions['tls'];
};

export function getDefaultServerOptions(): RequiredServerOptions {
  return {
    address: 'localhost:7233',
    identity: `${process.pid}@${os.hostname()}`,
    namespace: 'default',
    workerBinaryId: `${pkg.name}@${pkg.version}`,
  };
}

export function compileServerOptions(options: RequiredServerOptions): RequiredServerOptions {
  const { address, ...rest } = options;
  // eslint-disable-next-line prefer-const
  let [host, port] = address.split(':', 2);
  port = port || '7233';
  return { ...rest, address: `${host}:${port}` };
}
