import * as grpc from '@grpc/grpc-js';
import { temporal } from '@temporalio/proto';
import { TLSConfig, normalizeTlsConfig } from '@temporalio/common';

export type WorkflowService = temporal.api.workflowservice.v1.WorkflowService;
export const { WorkflowService } = temporal.api.workflowservice.v1;

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
   * @see options {@link https://grpc.github.io/grpc/core/group__grpc__arg__keys.html | here}
   */
  channelArgs?: Record<string, any>;
}

export type ConnectionOptionsWithDefaults = Required<Omit<ConnectionOptions, 'tls'>>;

export const LOCAL_DOCKER_TARGET = '127.0.0.1:7233';

export function defaultConnectionOpts(): ConnectionOptionsWithDefaults {
  return {
    address: LOCAL_DOCKER_TARGET,
    credentials: grpc.credentials.createInsecure(),
    channelArgs: {},
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
        ...(tls.serverNameOverride ? { 'grpc.ssl_target_name_override': tls.serverNameOverride } : undefined),
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
      return this.client.makeUnaryRequest(
        `/temporal.api.workflowservice.v1.WorkflowService/${method.name}`,
        (arg: any) => arg,
        (arg: any) => arg,
        requestData,
        // TODO: allow adding metadata and call options
        new grpc.Metadata(),
        {},
        callback
      );
    };
    this.service = new WorkflowService(rpcImpl, false, false);
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
