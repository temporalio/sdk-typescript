import { AsyncLocalStorage } from 'node:async_hooks';
import * as grpc from '@grpc/grpc-js';
import type { RPCImpl } from 'protobufjs';
import {
  filterNullAndUndefined,
  normalizeTlsConfig,
  TLSConfig,
  normalizeTemporalGrpcEndpointAddress,
} from '@temporalio/common/lib/internal-non-workflow';
import { Duration, msOptionalToNumber } from '@temporalio/common/lib/time';
import {
  CallContext,
  HealthService,
  Metadata,
  defaultGrpcRetryOptions,
  makeGrpcRetryInterceptor,
} from '@temporalio/client';
import pkg from './pkg';
import { CloudService } from './types';

/**
 * @experimental
 */
export interface CloudOperationsClientOptions {
  /**
   * Connection to use to communicate with the server.
   *
   * By default, connects to 'saas-api.tmprl.cloud:443'.
   */
  connection: CloudOperationsConnection;

  /**
   * Version header for safer mutations.
   * May or may not be required depending on cloud settings.
   */
  apiVersion?: string;
}

/**
 * High level SDK client.
 *
 * @experimental
 */
export class CloudOperationsClient {
  public readonly connection: CloudOperationsConnection;
  public readonly options: CloudOperationsClientOptions;

  constructor(options: CloudOperationsClientOptions) {
    this.connection = options.connection;
    this.options = filterNullAndUndefined(options ?? {});
  }

  /**
   * Set the deadline for any service requests executed in `fn`'s scope.
   */
  public async withDeadline<R>(deadline: number | Date, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withDeadline(deadline, fn);
  }

  /**
   * Set an {@link https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | `AbortSignal`} that, when aborted,
   * cancels any ongoing service requests executed in `fn`'s scope.
   *
   * @returns value returned from `fn`
   *
   * @see {@link Connection.withAbortSignal}
   */
  async withAbortSignal<R>(abortSignal: AbortSignal, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withAbortSignal(abortSignal, fn);
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

  /**
   * Raw gRPC access to the Temporal Cloud Operations service.
   *
   * **NOTE**: The API Version provided in {@link options} is **not** automatically set on requests made via this service
   * object.
   */
  get cloudService(): CloudService {
    return this.connection.cloudService;
  }
}

/**
 * gRPC and Temporal Server connection options
 *
 * @experimental
 */
export interface CloudOperationsConnectionOptions {
  /**
   * The address of the Temporal Cloud Operations API to connect to, in `hostname:port` format.
   *
   * @default saas-api.tmprl.cloud:443
   */
  address?: string;

  /**
   * TLS configuration. Pass `true` or `{}` to connect with TLS without any customization.
   * TLS is required for connecting to the Temporal Cloud Operations API.
   *
   @default true
   */
  tls?: Pick<TLSConfig, 'serverNameOverride'> | true;

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
   * Optional mapping of gRPC metadata (HTTP headers) to send with each request to the server. An
   * `Authorization` header set through `metadata` will be ignored and overriden by the value of the
   * {@link apiKey} option.
   *
   * In order to dynamically set metadata, use {@link Connection.withMetadata}
   */
  metadata?: Metadata;

  /**
   * API key for Temporal. This becomes the "Authorization" HTTP header with "Bearer " prepended.
   *
   * You may provide a static string or a callback. Also see {@link Connection.withApiKey} or
   * {@link Connection.setApiKey}
   */
  apiKey: string | (() => string);

  /**
   * Milliseconds to wait until establishing a connection with the server.
   *
   * Used either when connecting eagerly with {@link Connection.connect} or
   * calling {@link Connection.ensureConnected}.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @default 10 seconds
   */
  connectTimeout?: Duration;
}

export type ResolvedCloudOperationsConnectionOptions = Required<
  Omit<CloudOperationsConnectionOptions, 'tls' | 'connectTimeout'>
> & {
  connectTimeoutMs: number;
  credentials: grpc.ChannelCredentials;
};

/**
 * - Convert {@link ConnectionOptions.tls} to {@link grpc.ChannelCredentials}
 * - Add the grpc.ssl_target_name_override GRPC {@link ConnectionOptions.channelArgs | channel arg}
 * - Add default port to address if port not specified
 * - Set `Authorization` header based on {@link ConnectionOptions.apiKey}
 */
function normalizeGRPCConfig(options: CloudOperationsConnectionOptions): ResolvedCloudOperationsConnectionOptions {
  const {
    address: addressFromConfig,
    tls: tlsFromConfig,
    channelArgs,
    interceptors,
    connectTimeout,
    ...rest
  } = options;

  let address = 'saas-api.tmprl.cloud:443';
  if (addressFromConfig) {
    address = normalizeTemporalGrpcEndpointAddress(addressFromConfig);
  }
  const tls = normalizeTlsConfig(tlsFromConfig) ?? {};

  return {
    address,
    credentials: grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl()),
    channelArgs: {
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 15_000,
      max_receive_message_length: 128 * 1024 * 1024, // 128 MB
      ...channelArgs,
      ...(tls.serverNameOverride
        ? {
            'grpc.ssl_target_name_override': tls.serverNameOverride,
            'grpc.default_authority': tls.serverNameOverride,
          }
        : undefined),
    },
    interceptors: interceptors ?? [makeGrpcRetryInterceptor(defaultGrpcRetryOptions())],
    metadata: {},
    connectTimeoutMs: msOptionalToNumber(connectTimeout) ?? 10_000,
    ...filterNullAndUndefined(rest),
  };
}

interface RPCImplOptions {
  serviceName: string;
  client: grpc.Client;
  callContextStorage: AsyncLocalStorage<CallContext>;
  interceptors?: grpc.Interceptor[];
  staticMetadata: Metadata;
  apiKeyFnRef: { fn?: () => string };
}

interface CloudOperationsConnectionCtorOptions {
  readonly options: ResolvedCloudOperationsConnectionOptions;
  readonly client: grpc.Client;
  /**
   * Raw gRPC access to the
   * {@link https://github.com/temporalio/api-cloud/blob/main/temporal/api/cloud/cloudservice/v1/service.proto | Temporal Cloud's Operator Service}.
   */
  readonly cloudService: CloudService;
  /**
   * Raw gRPC access to the standard gRPC {@link https://github.com/grpc/grpc/blob/92f58c18a8da2728f571138c37760a721c8915a2/doc/health-checking.md | health service}.
   */
  readonly healthService: HealthService;
  readonly callContextStorage: AsyncLocalStorage<CallContext>;
  readonly apiKeyFnRef: { fn?: () => string };
}

/**
 * Client connection to the Temporal Server
 *
 * ⚠️ Connections are expensive to construct and should be reused. Make sure to {@link close} any unused connections to
 * avoid leaking resources.
 *
 * @experimental
 */
export class CloudOperationsConnection {
  /**
   * @internal
   */
  public static readonly Client = grpc.makeGenericClientConstructor({}, 'CloudService', {});

  public readonly options: ResolvedCloudOperationsConnectionOptions;
  protected readonly client: grpc.Client;

  /**
   * Used to ensure `ensureConnected` is called once.
   */
  protected connectPromise?: Promise<void>;

  /**
   * Raw gRPC access to the
   * {@link https://github.com/temporalio/api-cloud/blob/main/temporal/api/cloud/cloudservice/v1/service.proto | Temporal Cloud's Operator Service}.
   *
   * The Temporal Cloud Operator Service API defines how Temporal SDKs and other clients interact with the Temporal
   * Cloud platform to perform administrative functions like registering a search attribute or a namespace.
   *
   * This Service API is NOT compatible with self-hosted Temporal deployments.
   */
  public readonly cloudService: CloudService;

  public readonly healthService: HealthService;

  readonly callContextStorage: AsyncLocalStorage<CallContext>;
  private readonly apiKeyFnRef: { fn?: () => string };

  protected static createCtorOptions(options: CloudOperationsConnectionOptions): CloudOperationsConnectionCtorOptions {
    const normalizedOptions = normalizeGRPCConfig(options);
    const apiKeyFnRef: { fn?: () => string } = {};
    if (typeof normalizedOptions.apiKey === 'string') {
      const apiKey = normalizedOptions.apiKey;
      apiKeyFnRef.fn = () => apiKey;
    } else {
      apiKeyFnRef.fn = normalizedOptions.apiKey;
    }
    // Allow overriding this
    normalizedOptions.metadata['client-name'] ??= 'temporal-typescript';
    normalizedOptions.metadata['client-version'] ??= pkg.version;

    const client = new this.Client(
      normalizedOptions.address,
      normalizedOptions.credentials,
      normalizedOptions.channelArgs
    );
    const callContextStorage = new AsyncLocalStorage<CallContext>();

    const cloudRpcImpl = this.generateRPCImplementation({
      serviceName: 'temporal.api.cloud.cloudservice.v1.CloudService',
      client,
      callContextStorage,
      interceptors: normalizedOptions?.interceptors,
      staticMetadata: normalizedOptions.metadata,
      apiKeyFnRef,
    });
    const cloudService = CloudService.create(cloudRpcImpl, false, false);

    const healthRpcImpl = this.generateRPCImplementation({
      serviceName: 'grpc.health.v1.Health',
      client,
      callContextStorage,
      interceptors: normalizedOptions?.interceptors,
      staticMetadata: normalizedOptions.metadata,
      apiKeyFnRef,
    });
    const healthService = HealthService.create(healthRpcImpl, false, false);

    return {
      client,
      callContextStorage,
      cloudService,
      healthService,
      options: normalizedOptions,
      apiKeyFnRef,
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
      })();
    }
    return this.connectPromise;
  }

  /**
   * Create a lazy `CloudOperationsConnection` instance.
   *
   * This method does not verify connectivity with the server. We recommend using {@link connect} instead.
   */
  static lazy(options: CloudOperationsConnectionOptions): CloudOperationsConnection {
    return new this(this.createCtorOptions(options));
  }

  /**
   * Establish a connection with the server and return a `CloudOperationsConnection` instance.
   *
   * This is the preferred method of creating connections as it verifies connectivity by calling
   * {@link ensureConnected}.
   */
  static async connect(options: CloudOperationsConnectionOptions): Promise<CloudOperationsConnection> {
    const conn = this.lazy(options);
    await conn.ensureConnected();
    return conn;
  }

  protected constructor({
    options,
    client,
    cloudService,
    healthService,
    callContextStorage,
    apiKeyFnRef,
  }: CloudOperationsConnectionCtorOptions) {
    this.options = options;
    this.client = client;
    this.cloudService = cloudService;
    this.healthService = healthService;
    this.callContextStorage = callContextStorage;
    this.apiKeyFnRef = apiKeyFnRef;
  }

  protected static generateRPCImplementation({
    serviceName,
    client,
    callContextStorage,
    interceptors,
    staticMetadata,
    apiKeyFnRef,
  }: RPCImplOptions): RPCImpl {
    return (method: { name: string }, requestData: any, callback: grpc.requestCallback<any>) => {
      const metadataContainer = new grpc.Metadata();
      const { metadata, deadline, abortSignal } = callContextStorage.getStore() ?? {};
      if (apiKeyFnRef.fn) {
        metadataContainer.set('Authorization', `Bearer ${apiKeyFnRef.fn()}`);
      }
      for (const [k, v] of Object.entries(staticMetadata)) {
        metadataContainer.set(k, v);
      }
      if (metadata != null) {
        for (const [k, v] of Object.entries(metadata)) {
          metadataContainer.set(k, v);
        }
      }
      const call = client.makeUnaryRequest(
        `/${serviceName}/${method.name}`,
        (arg: any) => arg,
        (arg: any) => arg,
        requestData,
        metadataContainer,
        { interceptors, deadline },
        callback
      );
      if (abortSignal != null) {
        abortSignal.addEventListener('abort', () => call.cancel());
      }

      return call;
    };
  }

  /**
   * Set the deadline for any service requests executed in `fn`'s scope.
   *
   * @returns value returned from `fn`
   */
  async withDeadline<ReturnType>(deadline: number | Date, fn: () => Promise<ReturnType>): Promise<ReturnType> {
    const cc = this.callContextStorage.getStore();
    return await this.callContextStorage.run({ ...cc, deadline }, fn);
  }

  /**
   * Set an {@link https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | `AbortSignal`} that, when aborted,
   * cancels any ongoing requests executed in `fn`'s scope.
   *
   * @returns value returned from `fn`
   *
   * @example
   *
   * ```ts
   * const ctrl = new AbortController();
   * setTimeout(() => ctrl.abort(), 10_000);
   * // 👇 throws if incomplete by the timeout.
   * await conn.withAbortSignal(ctrl.signal, () => client.cloudService.someOperation(...));
   * ```
   */
  async withAbortSignal<ReturnType>(abortSignal: AbortSignal, fn: () => Promise<ReturnType>): Promise<ReturnType> {
    const cc = this.callContextStorage.getStore();
    return await this.callContextStorage.run({ ...cc, abortSignal }, fn);
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
   * ```ts
   * const result = await conn.withMetadata({ someMetadata: 'value' }, () =>
   *   conn.withMetadata({ otherKey: 'set' }, () => client.cloudService.someOperation(...)))
   * );
   * ```
   */
  async withMetadata<ReturnType>(metadata: Metadata, fn: () => Promise<ReturnType>): Promise<ReturnType> {
    const cc = this.callContextStorage.getStore();
    return await this.callContextStorage.run(
      {
        ...cc,
        metadata: { ...cc?.metadata, ...metadata },
      },
      fn
    );
  }

  /**
   * Set the apiKey for any service requests executed in `fn`'s scope (thus changing the `Authorization` header).
   *
   * @returns value returned from `fn`
   *
   * @example
   *
   * ```ts
   * const workflowHandle = await conn.withApiKey('secret', () =>
   *   conn.withMetadata({ otherKey: 'set' }, () => client.start(options)))
   * );
   * ```
   */
  async withApiKey<ReturnType>(apiKey: string, fn: () => Promise<ReturnType>): Promise<ReturnType> {
    const cc = this.callContextStorage.getStore();
    return await this.callContextStorage.run(
      {
        ...cc,
        metadata: { ...cc?.metadata, Authorization: `Bearer ${apiKey}` },
      },
      fn
    );
  }

  /**
   * Set the {@link ConnectionOptions.apiKey} for all subsequent requests. A static string or a
   * callback function may be provided.
   */
  setApiKey(apiKey: string | (() => string)): void {
    if (typeof apiKey === 'string') {
      if (apiKey === '') {
        throw new TypeError('`apiKey` must not be an empty string');
      }
      this.apiKeyFnRef.fn = () => apiKey;
    } else {
      this.apiKeyFnRef.fn = apiKey;
    }
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

  // This method is async for uniformity with Connection and NativeConnection
  /**
   * Close the underlying gRPC client.
   *
   * Make sure to call this method to ensure proper resource cleanup.
   */
  public async close(): Promise<void> {
    this.client.close();
  }
}
