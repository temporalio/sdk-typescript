import { AsyncLocalStorage } from 'node:async_hooks';
import * as grpc from '@grpc/grpc-js';
import type * as proto from 'protobufjs';
import {
  filterNullAndUndefined,
  normalizeTlsConfig,
  TLSConfig,
  normalizeGrpcEndpointAddress,
} from '@temporalio/common/lib/internal-non-workflow';
import { Duration, msOptionalToNumber } from '@temporalio/common/lib/time';
import { type temporal } from '@temporalio/proto';
import { isGrpcServiceError, ServiceError } from './errors';
import { defaultGrpcRetryOptions, makeGrpcRetryInterceptor } from './grpc-retry';
import pkg from './pkg';
import { CallContext, HealthService, Metadata, OperatorService, WorkflowService } from './types';

/**
 * The default Temporal Server's TCP port for public gRPC connections.
 */
const DEFAULT_TEMPORAL_GRPC_PORT = 7233;

/**
 * gRPC and Temporal Server connection options
 */
export interface ConnectionOptions {
  /**
   * The address of the Temporal server to connect to, in `hostname:port` format.
   *
   * Port defaults to 7233. Raw IPv6 addresses must be wrapped in square brackets (e.g. `[ipv6]:port`).
   *
   * @default localhost:7233
   */
  address?: string;

  /**
   * TLS configuration. Pass a falsy value to use a non-encrypted connection,
   * or `true` or `{}` to connect with TLS without any customization.
   *
   * For advanced scenario, a prebuilt {@link grpc.ChannelCredentials} object
   * may instead be specified using the {@link credentials} property.
   *
   * Either {@link credentials} or this may be specified for configuring TLS
   *
   * @default TLS is disabled
   */
  tls?: TLSConfig | boolean | null;

  /**
   * gRPC channel credentials.
   *
   * `ChannelCredentials` are things like SSL credentials that can be used to secure a connection.
   * There may be only one `ChannelCredentials`. They can be created using some of the factory
   * methods defined {@link https://grpc.github.io/grpc/node/grpc.credentials.html | here}
   *
   * Specifying a prebuilt `ChannelCredentials` should only be required for advanced use cases.
   * For simple TLS use cases, using the {@link tls} property is recommended. To register
   * `CallCredentials` (eg. metadata-based authentication), use the {@link callCredentials} property.
   *
   * Either {@link tls} or this may be specified for configuring TLS
   */
  credentials?: grpc.ChannelCredentials;

  /**
   * gRPC call credentials.
   *
   * `CallCredentials` generaly modify metadata; they can be attached to a connection to affect all method
   * calls made using that connection. They can be created using some of the factory methods defined
   * {@link https://grpc.github.io/grpc/node/grpc.credentials.html | here}
   *
   * If `callCredentials` are specified, they will be composed with channel credentials
   * (either the one created implicitely by using the {@link tls} option, or the one specified
   * explicitly through {@link credentials}). Notice that gRPC doesn't allow registering
   * `callCredentials` on insecure connections.
   */
  callCredentials?: grpc.CallCredentials[];

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
   * Setting the `Authorization` header is mutually exclusive with the {@link apiKey} option.
   *
   * In order to dynamically set metadata, use {@link Connection.withMetadata}
   */
  metadata?: Metadata;

  /**
   * API key for Temporal. This becomes the "Authorization" HTTP header with "Bearer " prepended.
   * This is mutually exclusive with the `Authorization` header in {@link ConnectionOptions.metadata}.
   *
   * You may provide a static string or a callback. Also see {@link Connection.withApiKey} or
   * {@link Connection.setApiKey}
   */
  apiKey?: string | (() => string);

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

export type ConnectionOptionsWithDefaults = Required<
  Omit<ConnectionOptions, 'tls' | 'connectTimeout' | 'callCredentials' | 'apiKey'>
> & {
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
      max_receive_message_length: 128 * 1024 * 1024, // 128 MB
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
 * - Set `Authorization` header based on {@link ConnectionOptions.apiKey}
 */
function normalizeGRPCConfig(options?: ConnectionOptions): ConnectionOptions {
  const { tls: tlsFromConfig, credentials, callCredentials, ...rest } = options || {};
  if (rest.apiKey) {
    if (rest.metadata?.['Authorization']) {
      throw new TypeError(
        'Both `apiKey` option and `Authorization` header were provided, but only one makes sense to use at a time.'
      );
    }
    if (credentials !== undefined) {
      throw new TypeError(
        'Both `apiKey` and `credentials` ConnectionOptions were provided, but only one makes sense to use at a time'
      );
    }
  }
  if (rest.address) {
    rest.address = normalizeGrpcEndpointAddress(rest.address, DEFAULT_TEMPORAL_GRPC_PORT);
  }
  const tls = normalizeTlsConfig(tlsFromConfig);
  if (tls) {
    if (credentials) {
      throw new TypeError('Both `tls` and `credentials` ConnectionOptions were provided');
    }
    return {
      ...rest,
      credentials: grpc.credentials.combineChannelCredentials(
        grpc.credentials.createSsl(tls.serverRootCACertificate, tls.clientCertPair?.key, tls.clientCertPair?.crt),
        ...(callCredentials ?? [])
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
    return {
      ...rest,
      credentials: grpc.credentials.combineChannelCredentials(
        credentials ?? grpc.credentials.createInsecure(),
        ...(callCredentials ?? [])
      ),
    };
  }
}

export interface RPCImplOptions {
  serviceName: string;
  client: grpc.Client;
  callContextStorage: AsyncLocalStorage<CallContext>;
  interceptors?: grpc.Interceptor[];
  staticMetadata: Metadata;
  apiKeyFnRef: { fn?: () => string };
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
  readonly apiKeyFnRef: { fn?: () => string };
}

/**
 * Client connection to the Temporal Server
 *
 * ⚠️ Connections are expensive to construct and should be reused.
 * Make sure to {@link close} any unused connections to avoid leaking resources.
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
   *
   * The Operator Service API defines how Temporal SDKs and other clients interact with the Temporal
   * server to perform administrative functions like registering a search attribute or a namespace.
   *
   * This Service API is NOT compatible with Temporal Cloud. Attempt to use it against a Temporal
   * Cloud namespace will result in gRPC `unauthorized` error.
   */
  public readonly operatorService: OperatorService;

  /**
   * Raw gRPC access to the standard gRPC {@link https://github.com/grpc/grpc/blob/92f58c18a8da2728f571138c37760a721c8915a2/doc/health-checking.md | health service}.
   */
  public readonly healthService: HealthService;

  readonly callContextStorage: AsyncLocalStorage<CallContext>;
  private readonly apiKeyFnRef: { fn?: () => string };

  protected static createCtorOptions(options?: ConnectionOptions): ConnectionCtorOptions {
    const normalizedOptions = normalizeGRPCConfig(options);
    const apiKeyFnRef: { fn?: () => string } = {};
    if (normalizedOptions.apiKey) {
      if (typeof normalizedOptions.apiKey === 'string') {
        const apiKey = normalizedOptions.apiKey;
        apiKeyFnRef.fn = () => apiKey;
      } else {
        apiKeyFnRef.fn = normalizedOptions.apiKey;
      }
    }
    const optionsWithDefaults = addDefaults(normalizedOptions);
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
      apiKeyFnRef,
    });
    const workflowService = WorkflowService.create(workflowRpcImpl, false, false);
    const operatorRpcImpl = this.generateRPCImplementation({
      serviceName: 'temporal.api.operatorservice.v1.OperatorService',
      client,
      callContextStorage,
      interceptors: optionsWithDefaults?.interceptors,
      staticMetadata: optionsWithDefaults.metadata,
      apiKeyFnRef,
    });
    const operatorService = OperatorService.create(operatorRpcImpl, false, false);
    const healthRpcImpl = this.generateRPCImplementation({
      serviceName: 'grpc.health.v1.Health',
      client,
      callContextStorage,
      interceptors: optionsWithDefaults?.interceptors,
      staticMetadata: optionsWithDefaults.metadata,
      apiKeyFnRef,
    });
    const healthService = HealthService.create(healthRpcImpl, false, false);

    return {
      client,
      callContextStorage,
      workflowService,
      operatorService,
      healthService,
      options: optionsWithDefaults,
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

        try {
          await this.withDeadline(deadline, () => this.workflowService.getSystemInfo({}));
        } catch (err) {
          if (isGrpcServiceError(err)) {
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
    apiKeyFnRef,
  }: ConnectionCtorOptions) {
    this.options = options;
    this.client = client;
    this.workflowService = this.withNamespaceHeaderInjector(workflowService);
    this.operatorService = operatorService;
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
  }: RPCImplOptions): proto.RPCImpl {
    return (
      method: proto.Method | proto.rpc.ServiceMethod<proto.Message<any>, proto.Message<any>>,
      requestData: Uint8Array,
      callback: grpc.requestCallback<any>
    ) => {
      const metadataContainer = new grpc.Metadata();
      const { metadata, deadline, abortSignal } = callContextStorage.getStore() ?? {};
      if (apiKeyFnRef.fn) {
        const apiKey = apiKeyFnRef.fn();
        if (apiKey) metadataContainer.set('Authorization', `Bearer ${apiKey}`);
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
   * Set a deadline for any service requests executed in `fn`'s scope.
   *
   * The deadline is a point in time after which any pending gRPC request will be considered as failed;
   * this will locally result in the request call throwing a {@link grpc.ServiceError|ServiceError}
   * with code {@link grpc.status.DEADLINE_EXCEEDED|DEADLINE_EXCEEDED}; see {@link isGrpcDeadlineError}.
   *
   * It is stronly recommended to explicitly set deadlines. If no deadline is set, then it is
   * possible for the client to end up waiting forever for a response.
   *
   * @param deadline a point in time after which the request will be considered as failed; either a
   *                 Date object, or a number of milliseconds since the Unix epoch (UTC).
   * @returns the value returned from `fn`
   *
   * @see https://grpc.io/docs/guides/deadlines/
   */
  async withDeadline<ReturnType>(deadline: number | Date, fn: () => Promise<ReturnType>): Promise<ReturnType> {
    const cc = this.callContextStorage.getStore();
    return await this.callContextStorage.run({ ...cc, deadline }, fn);
  }

  /**
   * Set an {@link AbortSignal} that, when aborted, cancels any ongoing service requests executed in
   * `fn`'s scope. This will locally result in the request call throwing a {@link grpc.ServiceError|ServiceError}
   * with code {@link grpc.status.CANCELLED|CANCELLED}; see {@link isGrpcCancelledError}.
   *
   * This method is only a convenience wrapper around {@link Connection.withAbortSignal}.
   *
   * @example
   *
   * ```ts
   * const ctrl = new AbortController();
   * setTimeout(() => ctrl.abort(), 10_000);
   * // 👇 throws if incomplete by the timeout.
   * await conn.withAbortSignal(ctrl.signal, () => client.workflow.execute(myWorkflow, options));
   * ```
   *
   * @returns value returned from `fn`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
   */
  // FIXME: `abortSignal` should be cumulative, i.e. if a signal is already set, it should be added
  //        to the list of signals, and both the new and existing signal should abort the request.
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
   * const workflowHandle = await conn.withMetadata({ apiKey: 'secret' }, () =>
   *   conn.withMetadata({ otherKey: 'set' }, () => client.start(options)))
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

  // This method is async for uniformity with NativeConnection which could be used in the future to power clients
  /**
   * Close the underlying gRPC client.
   *
   * Make sure to call this method to ensure proper resource cleanup.
   */
  public async close(): Promise<void> {
    this.client.close();
    this.callContextStorage.disable();
  }

  private withNamespaceHeaderInjector(
    workflowService: temporal.api.workflowservice.v1.WorkflowService
  ): temporal.api.workflowservice.v1.WorkflowService {
    const wrapper: any = {};

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    for (const [methodName, methodImpl] of Object.entries(workflowService) as [string, Function][]) {
      if (typeof methodImpl !== 'function') continue;

      wrapper[methodName] = (...args: any[]) => {
        const namespace = args[0]?.namespace;
        if (namespace) {
          return this.withMetadata({ 'temporal-namespace': namespace }, () => methodImpl.apply(workflowService, args));
        } else {
          return methodImpl.apply(workflowService, args);
        }
      };
    }
    return wrapper as WorkflowService;
  }
}
