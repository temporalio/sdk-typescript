import { IllegalStateError } from '@temporalio/common';
import { native } from '@temporalio/core-bridge';
import { TransportError } from './errors';
import { NativeConnectionOptions } from './connection-options';
import { Runtime } from './runtime';

/**
 * A Native Connection object that delegates calls to the Rust Core binary extension.
 *
 * A Worker must use this class to connect to the server.
 *
 * Do not confuse this connection class with `@temporalio/client`'s Connection.
 */
export class NativeConnection {
  /**
   * referenceHolders is used internally by the framework, it can be accessed with `extractReferenceHolders` (below)
   */
  private readonly referenceHolders = new Set<native.Worker>();

  /**
   * nativeClient is intentionally left private, framework code can access it with `extractNativeClient` (below)
   */
  protected constructor(
    private readonly runtime: Runtime,
    private readonly nativeClient: native.Client
  ) {}

  /**
   * @deprecated use `connect` instead
   */
  static async create(options?: NativeConnectionOptions): Promise<NativeConnection> {
    try {
      const runtime = Runtime.instance();
      const client = await runtime.createNativeClient(options);
      return new this(runtime, client);
    } catch (err) {
      if (err instanceof TransportError) {
        throw new TransportError(err.message);
      }
      throw err;
    }
  }

  /**
   * Eagerly connect to the Temporal server and return a NativeConnection instance
   */
  static async connect(options?: NativeConnectionOptions): Promise<NativeConnection> {
    try {
      const runtime = Runtime.instance();
      const client = await runtime.createNativeClient(options);
      return new this(runtime, client);
    } catch (err) {
      if (err instanceof TransportError) {
        throw new TransportError(err.message);
      }
      throw err;
    }
  }

  /**
   * Close this connection.
   *
   * Make sure any Workers using this connection are stopped before calling
   * this method or it will throw an {@link IllegalStateError}
   */
  async close(): Promise<void> {
    if (this.referenceHolders.size > 0) {
      throw new IllegalStateError('Cannot close connection while Workers hold a reference to it');
    }
    await this.runtime.closeNativeClient(this.nativeClient);
  }

  /**
   * Mapping of gRPC metadata (HTTP headers) to send with each request to the server.
   *
   * Use {@link NativeConnectionOptions.metadata} to set the initial metadata for client creation.
   */
  async setMetadata(metadata: Record<string, string>): Promise<void> {
    native.clientUpdateHeaders(this.nativeClient, metadata);
  }

  /**
   * Update the API key for this client. This is only set if `metadata` doesn't already have an
   * "authorization" key.
   *
   * Use {@link NativeConnectionOptions.apiKey} to set the initial metadata for client creation.
   */
  async setApiKey(apiKey: string): Promise<void> {
    native.clientUpdateApiKey(this.nativeClient, apiKey);
  }
}

/**
 * Extract the private native client instance from a `NativeConnection` instance.
 *
 * Only meant to be used by the framework.
 */
export function extractNativeClient(conn: NativeConnection): native.Client {
  return (conn as any).nativeClient;
}

/**
 * Extract the private referenceHolders set from a `NativeConnection` instance.
 *
 * Only meant to be used by the framework.
 */
export function extractReferenceHolders(conn: NativeConnection): Set<native.Worker> {
  return (conn as any).referenceHolders;
}

/**
 * Internal class used when a Worker directly instantiates a connection with no external references.
 *
 * This class is only used as a "marker" during Worker shutdown to decide whether to close the connection.
 */
export class InternalNativeConnection extends NativeConnection {}
