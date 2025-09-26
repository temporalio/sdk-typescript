import { AsyncLocalStorage } from 'node:async_hooks';
import * as grpc from '@grpc/grpc-js';
import * as proto from 'protobufjs';
import { IllegalStateError } from '@temporalio/common';
import { native } from '@temporalio/core-bridge';
import {
  ConnectionLike,
  Metadata,
  CallContext,
  WorkflowService,
  OperatorService,
  HealthService,
  TestService,
  InternalConnectionLikeSymbol,
} from '@temporalio/client';
import { InternalConnectionOptions, InternalConnectionOptionsSymbol } from '@temporalio/client/lib/connection';
import { TransportError } from './errors';
import { NativeConnectionOptions } from './connection-options';
import { Runtime } from './runtime';

/**
 * A Native Connection object that delegates calls to the Rust Core binary extension.
 *
 * A Worker must use this class to connect to the server.
 *
 * This class can be used to power `@temporalio/client`'s Client objects.
 */
export class NativeConnection implements ConnectionLike {
  /**
   * referenceHolders is used internally by the framework, it can be accessed with `extractReferenceHolders` (below)
   */
  private readonly referenceHolders = new Set<native.Worker>();

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

  /**
   * Raw gRPC access to Temporal Server's
   * {@link https://github.com/temporalio/api/blob/master/temporal/api/testservice/v1/service.proto | Test service}
   *
   * Will be `undefined` if connected to a server that does not support the test service.
   */
  public readonly testService: TestService | undefined;

  readonly callContextStorage = new AsyncLocalStorage<CallContext>();

  /**
   * nativeClient is intentionally left private, framework code can access it with `extractNativeClient` (below)
   */
  protected constructor(
    private readonly runtime: Runtime,
    private readonly nativeClient: native.Client,
    private readonly enableTestService: boolean
  ) {
    this.workflowService = WorkflowService.create(
      this.sendRequest.bind(this, native.clientSendWorkflowServiceRequest.bind(undefined, this.nativeClient)),
      false,
      false
    );
    this.operatorService = OperatorService.create(
      this.sendRequest.bind(this, native.clientSendOperatorServiceRequest.bind(undefined, this.nativeClient)),
      false,
      false
    );
    this.healthService = HealthService.create(
      this.sendRequest.bind(this, native.clientSendHealthServiceRequest.bind(undefined, this.nativeClient)),
      false,
      false
    );
    if (this.enableTestService) {
      this.testService = TestService.create(
        this.sendRequest.bind(this, native.clientSendTestServiceRequest.bind(undefined, this.nativeClient)),
        false,
        false
      );
    }

    // Set internal capability flag - not part of public API
    Object.defineProperty(this, InternalConnectionLikeSymbol, {
      value: { supportsEagerStart: true },
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  /**
   * No-op. This class can only be created via eager connection.
   */
  async ensureConnected(): Promise<void> {}

  private sendRequest(
    sendRequestNative: (req: native.RpcCall) => Promise<Buffer>,
    method: proto.Method | proto.rpc.ServiceMethod<proto.Message<any>, proto.Message<any>>,
    requestData: any,
    callback: grpc.requestCallback<any>
  ) {
    if (!isProtoMethod(method)) {
      throw new TypeError(`Invalid request method, expected a proto.Method instance: ${method.name}`);
    }
    const { resolvedResponseType } = method;
    if (resolvedResponseType == null) {
      throw new TypeError(`Invalid request method: ${method.name}`);
    }

    // TODO: add support for abortSignal

    const ctx = this.callContextStorage.getStore() ?? {};
    const metadata =
      ctx.metadata != null ? Object.fromEntries(Object.entries(ctx.metadata).map(([k, v]) => [k, v.toString()])) : {};

    const req = {
      rpc: method.name,
      req: requestData,
      retry: true,
      metadata,
      timeout: ctx.deadline ? getRelativeTimeout(ctx.deadline) : null,
    };

    sendRequestNative(req).then(
      (res) => {
        callback(null, resolvedResponseType.decode(Buffer.from(res)));
      },
      (err) => {
        callback(err);
      }
    );
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
   * Set metadata for any service requests executed in `fn`'s scope.
   *
   * The provided metadata is merged on top of any existing metadata in current scope, including metadata provided in
   * {@link NativeConnectionOptions.metadata}.
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
   * Set an {@link AbortSignal} that, when aborted, cancels any ongoing service requests executed in
   * `fn`'s scope. This will locally result in the request call throwing a {@link grpc.ServiceError|ServiceError}
   * with code {@link grpc.status.CANCELLED|CANCELLED}; see {@link isGrpcCancelledError}.
   *
   * This method is only a convenience wrapper around {@link NativeConnection.withAbortSignal}.
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
  async withAbortSignal<ReturnType>(abortSignal: AbortSignal, fn: () => Promise<ReturnType>): Promise<ReturnType> {
    const cc = this.callContextStorage.getStore();
    return await this.callContextStorage.run({ ...cc, abortSignal }, fn);
  }

  /**
   * @deprecated use `connect` instead
   */
  static async create(options?: NativeConnectionOptions): Promise<NativeConnection> {
    return this.connect(options);
  }

  /**
   * Eagerly connect to the Temporal server and return a NativeConnection instance
   */
  static async connect(options?: NativeConnectionOptions): Promise<NativeConnection> {
    const internalOptions = (options as InternalConnectionOptions)?.[InternalConnectionOptionsSymbol] ?? {};
    const enableTestService = internalOptions.supportsTestService ?? false;

    try {
      const runtime = Runtime.instance();
      const client = await runtime.createNativeClient(options);
      return new this(runtime, client, enableTestService);
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

function isProtoMethod(
  method: proto.Method | proto.rpc.ServiceMethod<proto.Message<any>, proto.Message<any>>
): method is proto.Method {
  return 'resolvedResponseType' in (method as any);
}

/**
 * See https://nodejs.org/api/timers.html#settimeoutcallback-delay-args
 * In particular, "When delay is larger than 2147483647 or less than 1, the
 * delay will be set to 1. Non-integer delays are truncated to an integer."
 * This number of milliseconds is almost 25 days.
 *
 * Copied from the grpc-js source code.
 */
const MAX_TIMEOUT_TIME = 2147483647;

/**
 * Get the timeout value that should be passed to setTimeout now for the timer
 * to end at the deadline. For any deadline before now, the timer should end
 * immediately, represented by a value of 0. For any deadline more than
 * MAX_TIMEOUT_TIME milliseconds in the future, a timer cannot be set that will
 * end at that time, so it is treated as infinitely far in the future.
 *
 * Copied from the grpc-js source code.
 */
function getRelativeTimeout(deadline: grpc.Deadline) {
  const deadlineMs = deadline instanceof Date ? deadline.getTime() : deadline;
  const now = new Date().getTime();
  const timeout = deadlineMs - now;
  if (timeout < 0) {
    return 0;
  } else if (timeout > MAX_TIMEOUT_TIME) {
    return Infinity;
  } else {
    return timeout;
  }
}
