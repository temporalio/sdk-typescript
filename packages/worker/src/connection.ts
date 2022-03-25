import { Client } from '@temporalio/core-bridge';
import { NativeConnectionOptions } from './connection-options';
import { Runtime } from './runtime';

/**
 * A Native Connection object that delegates calls to the Rust Core binary extension.
 *
 * A Worker must use this class to connect to the server.
 *
 * Do not confuse this Connection class with the `@temporalio/client`'s Connection.
 */
export class NativeConnection {
  // nativeClient is intentionally left private, framework code can access it with `extractNativeClient` (below)
  private constructor(private nativeClient: Client) {}

  static async create(options?: NativeConnectionOptions): Promise<NativeConnection> {
    const client = await Runtime.instance().createNativeClient(options);
    return new this(client);
  }
}

/**
 * Extract the private native client instance from a `NativeConnection` instance
 */
export function extractNativeClient(conn: NativeConnection): Client {
  return (conn as any).nativeClient;
}
