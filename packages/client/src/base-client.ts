import { DataConverter, LoadedDataConverter } from '@temporalio/common';
import { isLoadedDataConverter, loadDataConverter } from '@temporalio/common/lib/internal-non-workflow';
import { Connection } from './connection';
import { ConnectionLike, Metadata } from './types';
import * as os from 'os';

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

export type LoadedWithDefaults<Options extends BaseClientOptions> = //
  Required<Omit<Options, 'connection'>> &
    Pick<Options, 'connection'> & {
      loadedDataConverter: LoadedDataConverter;
    };

export class BaseClient {
  public readonly connection: ConnectionLike;
  protected readonly baseOptions: LoadedWithDefaults<BaseClientOptions>;

  protected constructor(options?: BaseClientOptions) {
    this.connection = options?.connection ?? Connection.lazy();
    const dataConverter = options?.dataConverter ?? {};
    const loadedDataConverter = isLoadedDataConverter(dataConverter) ? dataConverter : loadDataConverter(dataConverter);
    this.baseOptions = {
      dataConverter,
      identity: options?.identity ?? `${process.pid}@${os.hostname()}`,
      namespace: options?.namespace ?? 'default',
      loadedDataConverter,
    };
  }

  /**
   * Set the deadline for any service requests executed in `fn`'s scope.
   */
  public async withDeadline<R>(deadline: number | Date, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withDeadline(deadline, fn);
  }

  /**
   * Set metadata for any service requests executed in `fn`'s scope.
   *
   * @returns returned value of `fn`
   *
   * @see {@link Connection.withMetadata}
   */
  public async withMetadata<R>(metadata: Metadata, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withMetadata(metadata, fn);
  }

  protected get dataConverter(): LoadedDataConverter {
    return this.baseOptions.loadedDataConverter;
  }
}
