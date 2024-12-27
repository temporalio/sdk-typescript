import os from 'node:os';
import type * as _grpc from '@grpc/grpc-js'; // For JSDoc only
import { DataConverter, LoadedDataConverter } from '@temporalio/common';
import { isLoadedDataConverter, loadDataConverter } from '@temporalio/common/lib/internal-non-workflow';
import { Connection } from './connection';
import { ConnectionLike, Metadata } from './types';

export interface BaseClientOptions {
  /**
   * {@link DataConverter} to use for serializing and deserializing payloads
   */
  dataConverter?: DataConverter;

  /**
   * Identity to report to the server
   *
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;

  /**
   * Connection to use to communicate with the server.
   *
   * By default, connects to localhost.
   *
   * Connections are expensive to construct and should be reused.
   */
  connection?: ConnectionLike;

  /**
   * Server namespace
   *
   * @default default
   */
  namespace?: string;
}

export type WithDefaults<Options extends BaseClientOptions> = //
  Required<Omit<Options, 'connection'>> & Pick<Options, 'connection'>;

export type LoadedWithDefaults<Options extends BaseClientOptions> = //
  WithDefaults<Options> & {
    loadedDataConverter: LoadedDataConverter;
  };

export function defaultBaseClientOptions(): WithDefaults<BaseClientOptions> {
  return {
    dataConverter: {},
    identity: `${process.pid}@${os.hostname()}`,
    namespace: 'default',
  };
}

export class BaseClient {
  /**
   * The underlying {@link Connection | connection} used by this client.
   *
   * Clients are cheap to create, but connections are expensive. Where it makes sense,
   * a single connection may and should be reused by multiple `Client`s.
   */
  public readonly connection: ConnectionLike;

  private readonly loadedDataConverter: LoadedDataConverter;

  protected constructor(options?: BaseClientOptions) {
    this.connection = options?.connection ?? Connection.lazy();
    const dataConverter = options?.dataConverter ?? {};
    this.loadedDataConverter = isLoadedDataConverter(dataConverter) ? dataConverter : loadDataConverter(dataConverter);
  }

  /**
   * Set a deadline for any service requests executed in `fn`'s scope.
   *
   * The deadline is a point in time after which any pending gRPC request will be considered as failed;
   * this will locally result in the request call throwing a {@link _grpc.ServiceError|ServiceError}
   * with code {@link _grpc.status.DEADLINE_EXCEEDED|DEADLINE_EXCEEDED}; see {@link isGrpcDeadlineError}.
   *
   * It is stronly recommended to explicitly set deadlines. If no deadline is set, then it is
   * possible for the client to end up waiting forever for a response.
   *
   * This method is only a convenience wrapper around {@link Connection.withDeadline}.
   *
   * @param deadline a point in time after which the request will be considered as failed; either a
   *                 Date object, or a number of milliseconds since the Unix epoch (UTC).
   * @returns the value returned from `fn`
   *
   * @see https://grpc.io/docs/guides/deadlines/
   */
  public async withDeadline<R>(deadline: number | Date, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withDeadline(deadline, fn);
  }

  /**
   * Set an {@link AbortSignal} that, when aborted, cancels any ongoing service requests executed in
   * `fn`'s scope. This will locally result in the request call throwing a {@link _grpc.ServiceError|ServiceError}
   * with code {@link _grpc.status.CANCELLED|CANCELLED}; see {@link isGrpcCancelledError}.
   *
   * This method is only a convenience wrapper around {@link Connection.withAbortSignal}.
   *
   * @returns value returned from `fn`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
   */
  async withAbortSignal<R>(abortSignal: AbortSignal, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withAbortSignal(abortSignal, fn);
  }

  /**
   * Set metadata for any service requests executed in `fn`'s scope.
   *
   * This method is only a convenience wrapper around {@link Connection.withMetadata}.
   *
   * @returns returned value of `fn`
   */
  public async withMetadata<R>(metadata: Metadata, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withMetadata(metadata, fn);
  }

  protected get dataConverter(): LoadedDataConverter {
    return this.loadedDataConverter;
  }
}
