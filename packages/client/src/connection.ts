import * as grpc from '@grpc/grpc-js';
import { normalizeTlsConfig, TLSConfig } from '@temporalio/internal-non-workflow-common';
import { AsyncLocalStorage } from 'async_hooks';
import type { RPCImpl } from 'protobufjs';
import { isServerErrorResponse, ServiceError } from './errors';
import { defaultGrpcRetryOptions, makeGrpcRetryInterceptor } from './grpc-retry';
import { CallContext, Metadata, WorkflowService } from './types';

/**
 * GRPC + Temporal server connection options
 */
export interface ConnectionOptions {
  /**
   * Server hostname and optional port.
   * Port defaults to 7233 if address contains only host.
   *
   * @default localhost:7233
   */
  address?: string;

  /**
   * TLS configuration.
   * Pass a falsy value to use a non-encrypted connection or `true` or `{}` to
   * connect with TLS without any customization.
   *
   * Either {@link credentials} or this may be specified for configuring TLS
   */
  tls?: TLSConfig | boolean | null;

  /**
   * Channel credentials, create using the factory methods defined {@link https://grpc.github.io/grpc/node/grpc.credentials.html | here}
   *
   * Either {@link tls} or this may be specified for configuring TLS
   */
  credentials?: grpc.ChannelCredentials;

  /**
   * GRPC Channel arguments
   *
   * @see option descriptions {@link https://grpc.github.io/grpc/core/group__grpc__arg__keys.html | here}
   */
  channelArgs?: grpc.ChannelOptions;

  /**
   * Grpc interceptors which will be applied to every RPC call performed by this connection. By
   * default, an interceptor will be included which automatically retries retryable errors. If you
   * do not wish to perform automatic retries, set this to an empty list (or a list with your own
   * interceptors).
   */
  interceptors?: grpc.Interceptor[];
}

export type ConnectionOptionsWithDefaults = Required<Omit<ConnectionOptions, 'tls'>>;

export const LOCAL_TARGET = '127.0.0.1:7233';

export function defaultConnectionOpts(): ConnectionOptionsWithDefaults {
  return {
    address: LOCAL_TARGET,
    credentials: grpc.credentials.createInsecure(),
    channelArgs: {},
    interceptors: [makeGrpcRetryInterceptor(defaultGrpcRetryOptions())],
  };
}

/**
 * - Convert {@link ConnectionOptions.tls} to {@link grpc.ChannelCredentials}
 * - Add the grpc.ssl_target_name_override GRPC {@link ConnectionOptions.channelArgs | channel arg}
 * - Add default port to address if port not specified
 */
function normalizeGRPCConfig(options?: ConnectionOptions): ConnectionOptions {
  const { tls: tlsFromConfig, credentials, ...rest } = options || {};
  if (rest.address) {
    // eslint-disable-next-line prefer-const
    let [host, port] = rest.address.split(':', 2);
    port = port || '7233';
    rest.address = `${host}:${port}`;
  }
  const tls = normalizeTlsConfig(tlsFromConfig);
  if (tls) {
    if (credentials) {
      throw new TypeError('Both `tls` and `credentials` ConnectionOptions were provided');
    }
    return {
      ...rest,
      credentials: grpc.credentials.createSsl(
        tls.serverRootCACertificate,
        tls.clientCertPair?.key,
        tls.clientCertPair?.crt
      ),
      channelArgs: {
        ...rest.channelArgs,
        ...(tls.serverNameOverride
          ? {
              'grpc.ssl_target_name_override': tls.serverNameOverride,
              'grpc.default_authority': tls.serverNameOverride,
            }
          : undefined),
      },
    };
  } else {
    return rest;
  }
}

export interface RPCImplOptions {
  serviceName: string;
  client: grpc.Client;
  callContextStorage: AsyncLocalStorage<CallContext>;
  interceptors?: grpc.Interceptor[];
}

export interface ConnectionCtorOptions {
  readonly options: ConnectionOptionsWithDefaults;
  readonly client: grpc.Client;
  /**
   * Raw gRPC access to the Temporal service.
   *
   * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests made to the service.
   */
  readonly workflowService: WorkflowService;
  readonly callContextStorage: AsyncLocalStorage<CallContext>;
}

/**
 * Client connection to the Temporal Service
 *
 * NOTE: Connections are expensive to construct and should be reused.
 * Make sure to `close()` any unused connections to avoid leaking resources.
 */
export class Connection {
  public static readonly Client = grpc.makeGenericClientConstructor({}, 'WorkflowService', {});

  public readonly options: ConnectionOptionsWithDefaults;
  protected readonly client: grpc.Client;
  /**
   * Used to ensure `ensureConnected` is called once.
   */
  protected connectPromise?: Promise<void>;

  /**
   * Raw gRPC access to the Temporal service.
   *
   * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests made to the service.
   */
  public readonly workflowService: WorkflowService;
  readonly callContextStorage: AsyncLocalStorage<CallContext>;

  protected static createCtorOptions(options?: ConnectionOptions): ConnectionCtorOptions {
    const optionsWithDefaults = {
      ...defaultConnectionOpts(),
      ...normalizeGRPCConfig(options),
    };
    const client = new this.Client(
      optionsWithDefaults.address,
      optionsWithDefaults.credentials,
      optionsWithDefaults.channelArgs
    );
    const callContextStorage = new AsyncLocalStorage<CallContext>();

    const rpcImpl = this.generateRPCImplementation({
      serviceName: 'temporal.api.workflowservice.v1.WorkflowService',
      client,
      callContextStorage,
      interceptors: optionsWithDefaults?.interceptors,
    });
    const workflowService = WorkflowService.create(rpcImpl, false, false);

    return {
      client,
      callContextStorage,
      workflowService,
      options: optionsWithDefaults,
    };
  }

  async ensureConnected(): Promise<void> {
    if (this.connectPromise == null) {
      const deadline = Date.now() + 10_000; // TODO: make this configurable
      this.connectPromise = (async () => {
        await this.untilReady(deadline);

        try {
          await this.withDeadline(deadline, () => this.workflowService.getSystemInfo({}));
        } catch (err) {
          if (isServerErrorResponse(err)) {
            // Ignore old servers
            if (err.code !== grpc.status.UNIMPLEMENTED) {
              throw new ServiceError('Failed to connect to Temporal server', { cause: err });
            }
          } else {
            throw err;
          }
        }
      })();
    }
    return this.connectPromise;
  }

  static lazy(options?: ConnectionOptions): Connection {
    return new this(this.createCtorOptions(options));
  }

  static async connect(options?: ConnectionOptions): Promise<Connection> {
    const conn = this.lazy(options);
    await conn.ensureConnected();
    return conn;
  }

  protected constructor({ options, client, workflowService, callContextStorage }: ConnectionCtorOptions) {
    this.options = options;
    this.client = client;
    this.workflowService = workflowService;
    this.callContextStorage = callContextStorage;
  }

  protected static generateRPCImplementation({
    serviceName,
    client,
    callContextStorage,
    interceptors,
  }: RPCImplOptions): RPCImpl {
    return (method: { name: string }, requestData: any, callback: grpc.requestCallback<any>) => {
      const metadataContainer = new grpc.Metadata();
      const { metadata, deadline } = callContextStorage.getStore() ?? {};
      if (metadata != null) {
        for (const [k, v] of Object.entries(metadata)) {
          metadataContainer.set(k, v);
        }
      }
      return client.makeUnaryRequest(
        `/${serviceName}/${method.name}`,
        (arg: any) => arg,
        (arg: any) => arg,
        requestData,
        metadataContainer,
        { interceptors, deadline },
        callback
      );
    };
  }

  /**
   * Set the deadline for any service requests executed in `fn`'s scope.
   */
  async withDeadline<R>(deadline: number | Date, fn: () => Promise<R>): Promise<R> {
    const cc = this.callContextStorage.getStore();
    return await this.callContextStorage.run({ deadline, metadata: cc?.metadata }, fn);
  }

  /**
   * Set metadata for any service requests executed in `fn`'s scope.
   *
   * @returns returned value of `fn`
   */
  async withMetadata<R>(metadata: Metadata, fn: () => Promise<R>): Promise<R>;

  /**
   * Set metadata for any service requests executed in `fn`'s scope.
   *
   * @param metadataFn function that gets current context metadata and returns new metadata
   *
   * @returns returned value of `fn`
   */
  async withMetadata<R>(metadataFn: (meta: Metadata) => Metadata, fn: () => Promise<R>): Promise<R>;

  async withMetadata<R>(metadata: Metadata | ((meta: Metadata) => Metadata), fn: () => Promise<R>): Promise<R> {
    // TODO: merge + test it
    const cc = this.callContextStorage.getStore();
    metadata = typeof metadata === 'function' ? metadata(cc?.metadata ?? {}) : metadata;
    return await this.callContextStorage.run({ metadata, deadline: cc?.deadline }, fn);
  }

  /**
   * Set the {@link CallContext} for any service requests executed in `fn`'s scope.
   *
   * @returns returned value of `fn`
   */
  async withCallContext<R>(cx: CallContext, fn: () => Promise<R>): Promise<R>;

  /**
   * Set the {@link CallContext} for any service requests executed in `fn`'s scope.
   *
   * @param cxFn function that gets current context and returns new context
   *
   * @returns returned value of `fn`
   */
  async withCallContext<R>(cxFn: (cx?: CallContext) => CallContext, fn: () => Promise<R>): Promise<R>;

  async withCallContext<R>(cx: CallContext | ((cx?: CallContext) => CallContext), fn: () => Promise<R>): Promise<R> {
    cx = typeof cx === 'function' ? cx(this.callContextStorage.getStore()) : cx;
    return await this.callContextStorage.run(cx, fn);
  }

  /**
   * Wait for successful connection to the server.
   *
   * @see https://grpc.github.io/grpc/node/grpc.Client.html#waitForReady__anchor
   */
  protected async untilReady(deadline: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.waitForReady(deadline, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  // This method is async for uniformity with NativeConnection which could be used in the future to power clients
  /**
   * Close the underlying gRPC client.
   *
   * Make sure to call this method to ensure proper resource cleanup.
   */
  public async close(): Promise<void> {
    this.client.close();
  }
}
