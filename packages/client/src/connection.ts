import * as grpc from '@grpc/grpc-js';
import { normalizeTlsConfig, TLSConfig } from '@temporalio/internal-non-workflow-common';
import { temporal } from '@temporalio/proto';
import { AsyncLocalStorage } from 'async_hooks';
import { defaultGrpcRetryOptions, makeGrpcRetryInterceptor } from './grpc-retry';

export type WorkflowService = temporal.api.workflowservice.v1.WorkflowService;
export const { WorkflowService } = temporal.api.workflowservice.v1;
export { TLSConfig };

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

export const LOCAL_DOCKER_TARGET = '127.0.0.1:7233';

export function defaultConnectionOpts(): ConnectionOptionsWithDefaults {
  return {
    address: LOCAL_DOCKER_TARGET,
    credentials: grpc.credentials.createInsecure(),
    channelArgs: {},
    interceptors: [makeGrpcRetryInterceptor(defaultGrpcRetryOptions())],
  };
}

/**
 * Mapping of string to valid gRPC metadata value
 */
export type Metadata = Record<string, grpc.MetadataValue>;

/**
 * User defined context for gRPC client calls
 */
export interface CallContext {
  /**
   * {@link Deadline | https://grpc.io/blog/deadlines/} for gRPC client calls
   */
  deadline?: number | Date;
  /**
   * Metadata to set on gRPC requests
   */
  metadata?: Metadata;
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

/**
 * Client connection to the Temporal Service
 */
export class Connection {
  public static readonly Client = grpc.makeGenericClientConstructor({}, 'WorkflowService', {});
  public readonly options: ConnectionOptionsWithDefaults;
  public readonly client: grpc.Client;
  /**
   * Raw gRPC access to the Temporal service.
   *
   * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests made to the service.
   */
  public readonly service: WorkflowService;

  constructor(options?: ConnectionOptions) {
    this.options = {
      ...defaultConnectionOpts(),
      ...normalizeGRPCConfig(options),
    };
    this.client = new Connection.Client(this.options.address, this.options.credentials, this.options.channelArgs);
    const rpcImpl = (method: { name: string }, requestData: any, callback: grpc.requestCallback<any>) => {
      const metadataContainer = new grpc.Metadata();
      const { metadata, deadline } = this.callContextStorage.getStore() ?? {};
      if (metadata != null) {
        for (const [k, v] of Object.entries(metadata)) {
          metadataContainer.set(k, v);
        }
      }
      return this.client.makeUnaryRequest(
        `/temporal.api.workflowservice.v1.WorkflowService/${method.name}`,
        (arg: any) => arg,
        (arg: any) => arg,
        requestData,
        metadataContainer,
        { interceptors: this.options.interceptors, deadline },
        callback
      );
    };
    this.service = WorkflowService.create(rpcImpl, false, false);
  }

  readonly callContextStorage = new AsyncLocalStorage<CallContext>();

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
   * @param waitTimeMs milliseconds to wait before giving up.
   *
   * @see https://grpc.github.io/grpc/node/grpc.Client.html#waitForReady__anchor
   */
  public async untilReady(waitTimeMs = 5000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.waitForReady(Date.now() + waitTimeMs, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
