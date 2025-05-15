import * as nexus from 'nexus-rpc';
import { status } from '@grpc/grpc-js';
import * as protobuf from 'protobufjs';
import * as protoJsonSerializer from 'proto3-json-serializer';

import { withContext } from 'nexus-rpc/lib/handler';
import {
  ApplicationFailure,
  CancelledFailure,
  IllegalStateError,
  LoadedDataConverter,
  Payload,
  PayloadConverter,
  SdkComponent,
} from '@temporalio/common';
import { temporal, coresdk } from '@temporalio/proto';
import { HandlerContext } from '@temporalio/nexus/lib/context';
import { encodeToPayload, encodeErrorToFailure, decodeOptionalSingle } from '@temporalio/common/lib/internal-non-workflow';
import { fixBuffers } from '@temporalio/common/lib/proto-utils';
import { isAbortError } from '@temporalio/common/lib/type-helpers';
import { isGrpcServiceError, ServiceError } from '@temporalio/client';
import { Logger, withMetadata } from './logger';

const UNINITIALIZED = Symbol();
// fullName isn't part of the generated typed unfortunately.
const TEMPORAL_FAILURE_METADATA = { type: (temporal.api.failure.v1.Failure as any).fullName.slice(1) };

async function errorToNexusFailure(
  dataConverter: LoadedDataConverter,
  err: unknown
): Promise<temporal.api.nexus.v1.IFailure> {
  const failure = await encodeErrorToFailure(dataConverter, err);
  const { message } = failure;
  delete failure.message;
  // TODO: there must be a more graceful way of passing this object to this function.
  const pbj = protoJsonSerializer.toProto3JSON(
    temporal.api.failure.v1.Failure.fromObject(failure) as any as protobuf.Message
  );
  return {
    message,
    metadata: TEMPORAL_FAILURE_METADATA,
    details: Buffer.from(JSON.stringify(fixBuffers(pbj))),
  };
}

export async function handlerErrorToProto(
  dataConverter: LoadedDataConverter,
  err: nexus.HandlerError
): Promise<temporal.api.nexus.v1.IHandlerError> {
  let retryBehavior: temporal.api.enums.v1.NexusHandlerErrorRetryBehavior =
    temporal.api.enums.v1.NexusHandlerErrorRetryBehavior.NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_UNSPECIFIED;
  if (err.retryable === true) {
    retryBehavior = temporal.api.enums.v1.NexusHandlerErrorRetryBehavior.NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_RETRYABLE;
  } else if (err.retryable === false) {
    retryBehavior =
      temporal.api.enums.v1.NexusHandlerErrorRetryBehavior.NEXUS_HANDLER_ERROR_RETRY_BEHAVIOR_NON_RETRYABLE;
  }
  let { cause } = err;
  if (cause == null) {
    // TODO: this messes up the call stack and creates unnecessary nesting.
    //
    // Create an error without capturing a stack trace.
    const wrapped = Object.create(Error.prototype);
    wrapped.message = err.message;
    wrapped.stack = err.stack;
    cause = wrapped;
  }
  return {
    errorType: err.type,
    failure: await errorToNexusFailure(dataConverter, cause),
    retryBehavior,
  };
}

export class NexusHandler {
  constructor(
    public readonly taskToken: Uint8Array,
    public readonly info: nexus.HandlerInfo,
    public readonly abortController: AbortController,
    public readonly serviceRegistry: nexus.ServiceRegistry,
    public readonly dataConverter: LoadedDataConverter,
    /**
     * Logger bound to `sdkComponent: worker`, with metadata from this Nexus task.
     * This is the logger to use for all log messages emitted by the Nexus
     * worker. Note this is not exactly the same thing as the Nexus context
     * logger, which is bound to `sdkComponent: nexus`.
     */
    private readonly workerLogger: Logger
  ) {
    this.workerLogger = withMetadata(workerLogger, () => this.getLogAttributes());
  }

  protected getLogAttributes(): Record<string, unknown> {
    return nexusLogAttributes(this.info);
  }

  protected async operationErrorToProto(
    err: nexus.OperationError
  ): Promise<temporal.api.nexus.v1.IUnsuccessfulOperationError> {
    let { cause } = err;
    if (cause == null) {
      // Create an error without capturing a stack trace.
      const wrapped = Object.create(Error.prototype);
      wrapped.message = err.message;
      wrapped.stack = err.stack;
      cause = wrapped;
    }
    return {
      operationState: err.state,
      failure: await errorToNexusFailure(this.dataConverter, cause),
    };
  }

  protected async startOperation(
    payload: Payload | undefined,
    options: nexus.StartOperationOptions
  ): Promise<coresdk.nexus.INexusTaskCompletion> {
    try {
      const decoded = await decodeOptionalSingle(this.dataConverter.payloadCodecs, payload);
      // Nexus headers have string values and Temporal Payloads have binary values. Instead of converting Payload
      // instances into Content instances, we embed the Payload in the serializer and pretend we are deserializing an
      // empty Content.
      const input = new nexus.LazyValue(
        new PayloadSerializer(this.dataConverter.payloadConverter, decoded ?? undefined),
        {},
      );
      const result = await this.invokeUserCode('startOperation', this.serviceRegistry.start.bind(this.serviceRegistry, this.info.service, this.info.operation, input, options));
      if (isAsyncResult(result)) {
        return {
          taskToken: this.taskToken,
          completed: {
            startOperation: {
              asyncSuccess: {
                operationToken: result.token,
                links: nexus.handlerLinks().map(nexusLinkToProtoLink),
              },
            },
          },
        };
      } else {
        return {
          taskToken: this.taskToken,
          completed: {
            startOperation: {
              syncSuccess: {
                payload: await encodeToPayload(this.dataConverter, result.value),
                links: nexus.handlerLinks().map(nexusLinkToProtoLink),
              },
            },
          },
        };
      }
    } catch (err) {
      if (err instanceof nexus.OperationError) {
        return {
          taskToken: this.taskToken,
          completed: {
            startOperation: {
              operationError: await this.operationErrorToProto(err),
            },
          },
        };
      }
      let handlerErr: nexus.HandlerError;
      if (err instanceof nexus.HandlerError) {
        handlerErr = err;
      } else {
        handlerErr = convertKnownErrors(err);
      }

      return {
        taskToken: this.taskToken,
        error: await handlerErrorToProto(this.dataConverter, handlerErr),
      };
    }
  }

  protected async cancelOperation(
    token: string,
    options: nexus.CancelOperationOptions
  ): Promise<coresdk.nexus.INexusTaskCompletion> {
    try {
      await this.invokeUserCode('cancelOperation', this.serviceRegistry.cancel.bind(this.serviceRegistry, this.info.service, this.info.operation, token, options));
      return {
        taskToken: this.taskToken,
        completed: {
          cancelOperation: {},
        },
      };
    } catch (err) {
      let handlerErr: nexus.HandlerError;
      if (err instanceof nexus.HandlerError) {
        handlerErr = err;
      } else {
        handlerErr = convertKnownErrors(err);
      }

      return {
        taskToken: this.taskToken,
        error: await handlerErrorToProto(this.dataConverter, handlerErr),
      };
    }
  }

  protected async invokeUserCode<R>(method: string, fn: () => Promise<R>): Promise<R> {
    let error: any = UNINITIALIZED; // In case someone decides to throw undefined...
    const startTime = process.hrtime.bigint();
    this.workerLogger.debug('Nexus handler started', { method });
    try {
      return await fn();
    } catch (err: any) {
      error = err;
      throw err;
    } finally {
      const durationNanos = process.hrtime.bigint() - startTime;
      const durationMs = Number(durationNanos / 1_000_000n);

      if (error === UNINITIALIZED) {
        this.workerLogger.debug('Nexus handler invocation completed', { method, durationMs });
      } else if ((error instanceof CancelledFailure || isAbortError(error)) && this.abortController.signal.aborted) {
        this.workerLogger.debug('Nexus handler invocation completed as cancelled', { method, durationMs });
      } else {
        this.workerLogger.warn('Nexus handler invocation failed', { method, error, durationMs });
      }
    }
  }

  /**
   * Actually executes the operation.
   *
   * Any call up to this function and including this one will be trimmed out of stack traces.
   */
  protected async execute(
    task: temporal.api.workflowservice.v1.IPollNexusTaskQueueResponse
  ): Promise<coresdk.nexus.INexusTaskCompletion> {
    if (task.request?.startOperation != null) {
      const variant = task.request?.startOperation;
      return await this.startOperation(variant.payload ?? undefined, {
        abortSignal: this.abortController.signal,
        headers: headersProxy(task.request.header),
        requestId: variant.requestId ?? undefined,
        links: (variant.links ?? []).map(protoLinkToNexusLink),
      });
    } else if (task.request?.cancelOperation != null) {
      const variant = task.request?.cancelOperation;
      if (variant.operationToken == null) {
        throw new nexus.HandlerError({
          type: 'BAD_REQUEST',
          message: 'Request missing operation token',
        });
      }
      return await this.cancelOperation(variant.operationToken, {
        abortSignal: this.abortController.signal,
        headers: headersProxy(task.request.header),
      });
    } else {
      throw new nexus.HandlerError({
        type: 'NOT_IMPLEMENTED',
        message: 'Request method not implemented',
      });
    }
  }

  public async run(
    task: temporal.api.workflowservice.v1.IPollNexusTaskQueueResponse
  ): Promise<coresdk.nexus.INexusTaskCompletion> {
    const context: HandlerContext = {
      info: this.info,
      links: [],
      log: withMetadata(this.workerLogger, { sdkComponent: SdkComponent.nexus }),
    };
    return await withContext(context, this.execute.bind(this, task));
  }
}

export function constructNexusHandlerInfo(
  request: temporal.api.nexus.v1.IRequest | null | undefined,
  abortSignal: AbortSignal
): nexus.HandlerInfo {
  const base = {
    abortSignal,
    headers: headersProxy(request?.header),
  };

  if (request?.startOperation != null) {
    const op = request.startOperation;
    if (op?.service == null) {
      throw new IllegalStateError('expected request service to not be empty');
    }
    if (op?.operation == null) {
      throw new IllegalStateError('expected request service to not be empty');
    }
    return { ...base, service: op.service, operation: op.operation };
  }
  if (request?.cancelOperation != null) {
    const op = request.cancelOperation;
    if (op?.service == null) {
      throw new IllegalStateError('expected request service to not be empty');
    }
    if (op?.operation == null) {
      throw new IllegalStateError('expected request service to not be empty');
    }
    return { ...base, service: op.service, operation: op.operation };
  }
  throw new nexus.HandlerError({
    type: 'NOT_IMPLEMENTED',
    message: 'Request method not implemented',
  });
}

export function nexusLogAttributes(info: nexus.HandlerInfo): Record<string, unknown> {
  return {
    service: info.service,
    operation: info.operation,
  };
}

function isAsyncResult(
  result: nexus.HandlerStartOperationResult<unknown>
): result is nexus.HandlerStartOperationResultAsync {
  return Object.hasOwnProperty.call(result, 'token') && typeof (result as any).token === 'string';
}

function convertKnownErrors(err: unknown): nexus.HandlerError {
  if (err instanceof ApplicationFailure && err.nonRetryable) {
    return new nexus.HandlerError({
      type: 'INTERNAL',
      cause: err,
      retryable: false,
    });
  }

  if (err instanceof ServiceError) {
    if (isGrpcServiceError(err.cause)) {
      switch (err.cause.code) {
        case status.INVALID_ARGUMENT:
          return new nexus.HandlerError({ type: 'BAD_REQUEST', cause: err });
        case (status.ALREADY_EXISTS, status.FAILED_PRECONDITION, status.OUT_OF_RANGE):
          return new nexus.HandlerError({ type: 'INTERNAL', cause: err, retryable: false });
        case (status.ABORTED, status.UNAVAILABLE):
          return new nexus.HandlerError({ type: 'UNAVAILABLE', cause: err });
        case (status.CANCELLED,
          status.DATA_LOSS,
          status.INTERNAL,
          status.UNKNOWN,
          status.UNAUTHENTICATED,
          status.PERMISSION_DENIED):
          // Note that UNAUTHENTICATED and PERMISSION_DENIED have Nexus error types but we convert to internal because
          // this is not a client auth error and happens when the handler fails to auth with Temporal and should be
          // considered retryable.
          return new nexus.HandlerError({ type: 'INTERNAL', cause: err });
        case status.NOT_FOUND:
          return new nexus.HandlerError({ type: 'NOT_FOUND', cause: err });
        case status.RESOURCE_EXHAUSTED:
          return new nexus.HandlerError({ type: 'RESOURCE_EXHAUSTED', cause: err });
        case status.UNIMPLEMENTED:
          return new nexus.HandlerError({ type: 'NOT_IMPLEMENTED', cause: err });
        case status.DEADLINE_EXCEEDED:
          return new nexus.HandlerError({ type: 'UPSTREAM_TIMEOUT', cause: err });
      }
    }
  }

  return new nexus.HandlerError({ cause: err, type: 'INTERNAL' });
}

function headersProxy(initializer?: Record<string, string> | null): Record<string, string> {
  const headers: Record<string, string> = initializer
    ? Object.fromEntries(Object.entries(initializer).map(([k, v]) => [k.toLowerCase(), v]))
    : {};
  return new Proxy(headers, {
    get(target, p) {
      if (typeof p !== 'string') {
        throw new TypeError('header keys must be strings');
      }
      return target[p.toLowerCase()];
    },
    set(target, p, newValue) {
      if (typeof p !== 'string') {
        throw new TypeError('header keys must be strings');
      }
      if (typeof newValue !== 'string') {
        throw new TypeError('header values must be strings');
      }
      target[p.toLowerCase()] = newValue;
      return true;
    },
  });
}

function protoLinkToNexusLink(plink: temporal.api.nexus.v1.ILink): nexus.Link {
  if (!plink.url) {
    throw new nexus.HandlerError({
      type: 'BAD_REQUEST',
      message: 'empty link URL',
    });
  }
  if (!plink.type) {
    throw new nexus.HandlerError({
      type: 'BAD_REQUEST',
      message: 'empty link type',
    });
  }
  return {
    url: new URL(plink.url),
    type: plink.type,
  };
}

function nexusLinkToProtoLink(nlink: nexus.Link): temporal.api.nexus.v1.ILink {
  return {
    url: nlink.url.toString(),
    type: nlink.type,
  };
}

/**
 * An adapter from a Temporal PayloadConverer and a Nexus Serializer.
 */
class PayloadSerializer implements nexus.Serializer {
  constructor(
    readonly payloadConverter: PayloadConverter,
    readonly payload?: Payload,
  ) { }

  deserialize<T>(): T {
    if (this.payload == null) {
      return undefined as T;
    }
    return this.payloadConverter.fromPayload(this.payload);
  }

  /** Not used in this path */
  serialize(): nexus.Content {
    throw new Error("not implemented");
  }
}
