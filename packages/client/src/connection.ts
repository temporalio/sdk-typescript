import { AsyncLocalStorage } from 'node:async_hooks';
import * as grpc from '@grpc/grpc-js';
import type { RPCImpl } from 'protobufjs';
import { filterNullAndUndefined, normalizeTlsConfig, TLSConfig } from '@temporalio/common/lib/internal-non-workflow';
import { msOptionalToNumber } from '@temporalio/common/lib/time';
import { isServerErrorResponse, ServiceError } from './errors';
import { defaultGrpcRetryOptions, makeGrpcRetryInterceptor } from './grpc-retry';
import pkg from './pkg';
import { CallContext, HealthService, Metadata, OperatorService, WorkflowService } from './types';

/**
 * gRPC and Temporal Server connection options
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
   *
   * By default the SDK sets the following keepalive arguments:
   *
   * ```
   * grpc.keepalive_permit_without_calls: 1
   * grpc.keepalive_time_ms: 30_000
   * grpc.keepalive_timeout_ms: 15_000
   * ```
   *
   * To opt-out of keepalive, override these keys with `undefined`.
   */
  channelArgs?: grpc.ChannelOptions;

  /**
   * {@link https://grpc.github.io/grpc/node/module-src_client_interceptors.html | gRPC interceptors} which will be
   * applied to every RPC call performed by this connection. By default, an interceptor will be included which
   * automatically retries retryable errors. If you do not wish to perform automatic retries, set this to an empty list
   * (or a list with your own interceptors). If you want to add your own interceptors while keeping the default retry
   * behavior, add this to your list of interceptors: `makeGrpcRetryInterceptor(defaultGrpcRetryOptions())`. See:
   *
   * - {@link makeGrpcRetryInterceptor}
   * - {@link defaultGrpcRetryOptions}
   */
  interceptors?: grpc.Interceptor[];

  /**
   * Optional mapping of gRPC metadata (HTTP headers) to send with each request to the server.
   *
   * In order to dynamically set metadata, use {@link Connection.withMetadata}
   */
  metadata?: Metadata;

  /**
   * Milliseconds to wait until establishing a connection with the server.
   *
   * Used either when connecting eagerly with {@link Connection.connect} or
   * calling {@link Connection.ensureConnected}.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @default 10 seconds
   */
  connectTimeout?: number | string;
}

export type ConnectionOptionsWithDefaults = Required<Omit<ConnectionOptions, 'tls' | 'connectTimeout'>> & {
  connectTimeoutMs: number;
};

export const LOCAL_TARGET = '127.0.0.1:7233';

function addDefaults(options: ConnectionOptions): ConnectionOptionsWithDefaults {
  const { channelArgs, interceptors, connectTimeout, ...rest } = options;
  return {
    address: LOCAL_TARGET,
    credentials: grpc.credentials.createInsecure(),
    channelArgs: {
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 15_000,
      ...channelArgs,
    },
    interceptors: interceptors ?? [makeGrpcRetryInterceptor(defaultGrpcRetryOptions())],
    metadata: {},
    connectTimeoutMs: msOptionalToNumber(connectTimeout) ?? 10_000,
    ...filterNullAndUndefined(rest),
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
  staticMetadata: Metadata;
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
  /**
   * Raw gRPC access to the Temporal {@link https://github.com/temporalio/api/blob/ddf07ab9933e8230309850e3c579e1ff34b03f53/temporal/api/operatorservice/v1/service.proto | operator service}.
   */
  readonly operatorService: OperatorService;
  /**
   * Raw gRPC access to the standard gRPC {@link https://github.com/grpc/grpc/blob/92f58c18a8da2728f571138c37760a721c8915a2/doc/health-checking.md | health service}.
   */
  readonly healthService: HealthService;
  readonly callContextStorage: AsyncLocalStorage<CallContext>;
}

/**
 * Client connection to the Temporal Server
 *
 * ⚠️ Connections are expensive to construct and should be reused. Make sure to {@link close} any unused connections to
 * avoid leaking resources.
 */
export class Connection {
  /**
   * @internal
   */
  public static readonly Client = grpc.makeGenericClientConstructor({}, 'WorkflowService', {});

  public readonly options: ConnectionOptionsWithDefaults;
  protected readonly client: grpc.Client;

  /**
   * Used to ensure `ensureConnected` is called once.
   */
  protected connectPromise?: Promise<void>;

  /**
   * Raw gRPC access to Temporal Server's {@link
   * https://github.com/temporalio/api/blob/master/temporal/api/workflowservice/v1/service.proto | Workflow service}
   */
  public readonly workflowService: WorkflowService;

  /**
   * Raw gRPC access to Temporal Server's
   * {@link https://github.com/temporalio/api/blob/master/temporal/api/operatorservice/v1/service.proto | Operator service}
   */
  public readonly operatorService: OperatorService;
  public readonly healthService: HealthService;
  readonly callContextStorage: AsyncLocalStorage<CallContext>;

  protected static createCtorOptions(options?: ConnectionOptions): ConnectionCtorOptions {
    const optionsWithDefaults = addDefaults(normalizeGRPCConfig(options));
    // Allow overriding this
    optionsWithDefaults.metadata['client-name'] ??= 'temporal-typescript';
    optionsWithDefaults.metadata['client-version'] ??= pkg.version;

    const client = new this.Client(
      optionsWithDefaults.address,
      optionsWithDefaults.credentials,
      optionsWithDefaults.channelArgs
    );
    const callContextStorage = new AsyncLocalStorage<CallContext>();

    const workflowRpcImpl = this.generateRPCImplementation({
      serviceName: 'temporal.api.workflowservice.v1.WorkflowService',
      client,
      callContextStorage,
      interceptors: optionsWithDefaults?.interceptors,
      staticMetadata: optionsWithDefaults.metadata,
    });
    const workflowService = WorkflowService.create(workflowRpcImpl, false, false);
    const operatorRpcImpl = this.generateRPCImplementation({
      serviceName: 'temporal.api.operatorservice.v1.OperatorService',
      client,
      callContextStorage,
      interceptors: optionsWithDefaults?.interceptors,
      staticMetadata: optionsWithDefaults.metadata,
    });
    const operatorService = OperatorService.create(operatorRpcImpl, false, false);
    const healthRpcImpl = this.generateRPCImplementation({
      serviceName: 'grpc.health.v1.Health',
      client,
      callContextStorage,
      interceptors: optionsWithDefaults?.interceptors,
      staticMetadata: optionsWithDefaults.metadata,
    });
    const healthService = HealthService.create(healthRpcImpl, false, false);

    return {
      client,
      callContextStorage,
      workflowService,
      operatorService,
      healthService,
      options: optionsWithDefaults,
    };
  }

  /**
   * Ensure connection can be established.
   *
   * Does not need to be called if you use {@link connect}.
   *
   * This method's result is memoized to ensure it runs only once.
   *
   * Calls {@link proto.temporal.api.workflowservice.v1.WorkflowService.getSystemInfo} internally.
   */
  async ensureConnected(): Promise<void> {
    if (this.connectPromise == null) {
      const deadline = Date.now() + this.options.connectTimeoutMs;
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

  /**
   * Create a lazy `Connection` instance.
   *
   * This method does not verify connectivity with the server. We recommend using {@link connect} instead.
   */
  static lazy(options?: ConnectionOptions): Connection {
    return new this(this.createCtorOptions(options));
  }

  /**
   * Establish a connection with the server and return a `Connection` instance.
   *
   * This is the preferred method of creating connections as it verifies connectivity by calling
   * {@link ensureConnected}.
   */
  static async connect(options?: ConnectionOptions): Promise<Connection> {
    const conn = this.lazy(options);
    await conn.ensureConnected();
    return conn;
  }

  protected constructor({
    options,
    client,
    workflowService,
    operatorService,
    healthService,
    callContextStorage,
  }: ConnectionCtorOptions) {
    this.options = options;
    this.client = client;
    this.workflowService = workflowService;
    this.operatorService = operatorService;
    this.healthService = healthService;
    this.callContextStorage = callContextStorage;
  }

  protected static generateRPCImplementation({
    serviceName,
    client,
    callContextStorage,
    interceptors,
    staticMetadata,
  }: RPCImplOptions): RPCImpl {
    return (method: { name: string }, requestData: any, callback: grpc.requestCallback<any>) => {
      const metadataContainer = new grpc.Metadata();
      const { metadata, deadline } = callContextStorage.getStore() ?? {};
      for (const [k, v] of Object.entries(staticMetadata)) {
        metadataContainer.set(k, v);
      }
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
   *
   * @returns value returned from `fn`
   */
  async withDeadline<ReturnType>(deadline: number | Date, fn: () => Promise<ReturnType>): Promise<ReturnType> {
    const cc = this.callContextStorage.getStore();
    return await this.callContextStorage.run({ deadline, metadata: cc?.metadata }, fn);
  }

  /**
   * Set metadata for any service requests executed in `fn`'s scope.
   *
   * The provided metadata is merged on top of any existing metadata in current scope, including metadata provided in
   * {@link ConnectionOptions.metadata}.
   *
   * @returns value returned from `fn`
   *
   * @example
   *
   *```ts
   *const workflowHandle = await conn.withMetadata({ apiKey: 'secret' }, () =>
   *  conn.withMetadata({ otherKey: 'set' }, () => client.start(options)))
   *);
   *```
   */
  async withMetadata<ReturnType>(metadata: Metadata, fn: () => Promise<ReturnType>): Promise<ReturnType> {
    const cc = this.callContextStorage.getStore();
    metadata = { ...cc?.metadata, ...metadata };
    return await this.callContextStorage.run({ metadata, deadline: cc?.deadline }, fn);
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
