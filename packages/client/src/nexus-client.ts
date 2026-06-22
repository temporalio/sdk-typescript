import { status as grpcStatus } from '@grpc/grpc-js';
import type * as nexus from 'nexus-rpc';
import { v4 as uuid4 } from 'uuid';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';
import {
  decodeTypedSearchAttributes,
  encodeUnifiedSearchAttributes,
  typedSearchAttributePayloadConverter,
} from '@temporalio/common/lib/converter/payload-search-attributes';
import {
  decodeFromPayloadsAtIndex,
  decodeOptionalFailureToOptionalError,
  decodeOptionalSinglePayload,
  encodeToPayload,
} from '@temporalio/common/lib/internal-non-workflow';
import { filterNullAndUndefined } from '@temporalio/common/lib/internal-workflow';
import { msOptionalToTs, optionalTsToDate, optionalTsToMs } from '@temporalio/common/lib/time';
import { temporal } from '@temporalio/proto';
import type { LoadedDataConverter } from '@temporalio/common';
import type { SearchAttributeType, TypedSearchAttributeValue } from '@temporalio/common/lib/search-attributes';
import { decode } from '@temporalio/common/lib/encoding';
import type { BaseClientOptions, LoadedWithDefaults, WithDefaults } from './base-client';
import { BaseClient, defaultBaseClientOptions } from './base-client';
import { isGrpcServiceError, ServiceError } from './errors';
import { rethrowKnownErrorTypes, extractNexusOperationAlreadyStartedRunId } from './helpers';
import type {
  CancelNexusOperationInput,
  CountNexusOperationsInput,
  DescribeNexusOperationInput,
  GetNexusOperationResultInput,
  ListNexusOperationsInput,
  NexusClientInterceptor,
  StartNexusOperationInput,
  TerminateNexusOperationInput,
} from './interceptors';
import {
  decodeNexusOperationCancellationState,
  decodeNexusOperationExecutionStatus,
  decodePendingNexusOperationState,
  encodeNexusOperationIdConflictPolicy,
  encodeNexusOperationIdReusePolicy,
} from './nexus-types';
import type {
  DescribeNexusOperationOptions,
  GetNexusOperationHandleOptions,
  ListNexusOperationsOptions,
  NexusOperationExecutionCancellationInfo,
  NexusOperationExecutionCount,
  NexusOperationExecutionDescription,
  NexusOperationExecution,
  RawNexusOperationExecutionCancellationInfo,
  RawNexusOperationExecutionInfo,
  RawNexusOperationExecutionListInfo,
  StartNexusOperationOptions,
} from './nexus-types';

export interface NexusClientOptions extends BaseClientOptions {
  /**
   * Used to override and extend default client behavior.
   */
  interceptors?: NexusClientInterceptor[];
}

export type LoadedNexusClientOptions = LoadedWithDefaults<NexusClientOptions>;

function defaultNexusClientOptions(): WithDefaults<NexusClientOptions> {
  return {
    ...defaultBaseClientOptions(),
    interceptors: [],
  };
}

/**
 * Handle to a standalone Nexus operation execution.
 *
 * Use this to poll for results, describe, cancel, or terminate the operation.
 *
 * @experimental Nexus Standalone Operations are experimental.
 */
export interface NexusOperationHandle<O = unknown> {
  readonly operationId: string;
  readonly runId?: string;
  readonly client: NexusClient;

  /**
   * Wait for the operation to complete and return its result.
   *
   * @throws {@link NexusOperationFailureError} if the operation completes with a failure outcome.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  result(): Promise<O>;

  /**
   * Describe the Nexus operation execution.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  describe(options?: DescribeNexusOperationOptions): Promise<NexusOperationExecutionDescription>;

  /**
   * Request cancellation of the operation.
   *
   * @param reason optional reason for the cancellation.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  cancel(reason?: string): Promise<void>;

  /**
   * Terminate the Nexus operation execution immediately.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  terminate(reason?: string): Promise<void>;
}

/**
 * Resolves the result type carried by a Nexus operation handle type hint.
 *
 * A NexusOperationHandle cannot infer a result type from an operation ID alone,
 * so callers may provide either the expected result type directly or a
 * Nexus operation definition type when acquiring a handle.
 * Operation definitions are unwrapped to their output type, all other types are
 * treated as the result type itself.
 */
type NexusOperationHandleResult<T> = T extends nexus.OperationDefinition<any, infer O> ? O : T;

/**
 * Typed service client for a specific Nexus service + endpoint pair.
 *
 * Created via {@link NexusClient.createServiceClient}. Provides type-safe
 * {@link startOperation} and {@link executeOperation} based on the service definition's operation types.
 *
 * @experimental Nexus Standalone Operations are experimental.
 */
export interface NexusServiceClient<T extends nexus.ServiceDefinition> {
  readonly endpoint: string;
  readonly service: T;

  /**
   * Start a Nexus operation and return a handle.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  startOperation<Op extends T['operations'][keyof T['operations']]>(
    operation: Op,
    input: nexus.OperationInput<Op>,
    options: StartNexusOperationOptions
  ): Promise<NexusOperationHandle<nexus.OperationOutput<Op>>>;
  startOperation<K extends nexus.OperationKey<T['operations']>>(
    op: K,
    input: nexus.OperationInput<T['operations'][K]>,
    options: StartNexusOperationOptions
  ): Promise<NexusOperationHandle<nexus.OperationOutput<T['operations'][K]>>>;

  /**
   * Start a Nexus operation and wait for its result.
   *
   * Convenience for {@link startOperation} followed by {@link NexusOperationHandle.result}.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  executeOperation<Op extends T['operations'][keyof T['operations']]>(
    operation: Op,
    input: nexus.OperationInput<Op>,
    options: StartNexusOperationOptions
  ): Promise<nexus.OperationOutput<Op>>;

  executeOperation<K extends nexus.OperationKey<T['operations']>>(
    op: K,
    input: nexus.OperationInput<T['operations'][K]>,
    options: StartNexusOperationOptions
  ): Promise<nexus.OperationOutput<T['operations'][K]>>;
}

/**
 * Client for standalone Nexus operations. Access via {@link Client.nexus}.
 *
 * Use {@link createServiceClient} to get a typed service client, or call the namespace-wide
 * {@link list}, {@link count}, and {@link getHandle} methods directly.
 *
 * @see {@link Client}
 *
 * @experimental Nexus Standalone Operations are experimental.
 */
export class NexusClient extends BaseClient {
  public readonly options: LoadedNexusClientOptions;
  protected readonly interceptors: NexusClientInterceptor[];

  constructor(options?: NexusClientOptions) {
    super(options);
    this.options = {
      ...defaultNexusClientOptions(),
      ...filterNullAndUndefined(options ?? {}),
      loadedDataConverter: this.dataConverter,
    };
    this.interceptors = this.options.interceptors;
  }

  /**
   * Create a typed service client for starting and executing Nexus operations on a specific endpoint + service.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  public createServiceClient<T extends nexus.ServiceDefinition>(options: {
    endpoint: string;
    service: T;
  }): NexusServiceClient<T> {
    const { endpoint, service } = options;

    type OperationReference<T extends nexus.ServiceDefinition> =
      | nexus.OperationKey<T['operations']>
      | T['operations'][nexus.OperationKey<T['operations']>];

    type OperationInput<
      T extends nexus.ServiceDefinition,
      Op extends OperationReference<T>,
    > = Op extends nexus.OperationKey<T['operations']>
      ? nexus.OperationInput<T['operations'][Op]>
      : nexus.OperationInput<Op>;

    type OperationOutput<
      T extends nexus.ServiceDefinition,
      Op extends OperationReference<T>,
    > = Op extends nexus.OperationKey<T['operations']>
      ? nexus.OperationOutput<T['operations'][Op]>
      : nexus.OperationOutput<Op>;

    const startOperation = async <Op extends OperationReference<T>>(
      operation: Op,
      input: OperationInput<T, Op>,
      options: StartNexusOperationOptions
    ): Promise<NexusOperationHandle<OperationOutput<T, Op>>> => {
      let operationName: string;
      if (typeof operation === 'string') {
        const op = service.operations[operation];
        if (op == null) {
          // The OperationReference<T> type guarantees that if operation is
          // a string then it is a key of service.operations. This runtime
          // check is for extra safety.
          throw new TypeError(
            `Unable to resolve Nexus operation name from key ${operation} for service ${service.name}`
          );
        }
        operationName = op.name;
      } else {
        operationName = operation.name;
      }

      const handle = await this.startNexusOperation({
        endpoint,
        service: service.name,
        operation: operationName,
        arg: input,
        id: options.id,
        scheduleToCloseTimeout: options.scheduleToCloseTimeout,
        scheduleToStartTimeout: options.scheduleToStartTimeout,
        startToCloseTimeout: options.startToCloseTimeout,
        summary: options.summary,
        idReusePolicy: options.idReusePolicy,
        idConflictPolicy: options.idConflictPolicy,
        searchAttributes: options.searchAttributes,
        headers: options.headers,
      });

      // The interceptor layer returns NexusOperationHandle<unknown>, so reapply
      // the output type here to match the OperationDefinition contract.
      return handle as NexusOperationHandle<OperationOutput<T, Op>>;
    };

    const executeOperation = async <Op extends OperationReference<T>>(
      operation: Op,
      input: OperationInput<T, Op>,
      options: StartNexusOperationOptions
    ): Promise<OperationOutput<T, Op>> => {
      const handle = await startOperation(operation, input, options);
      return await handle.result();
    };

    return {
      endpoint,
      service,
      startOperation,
      executeOperation,
    };
  }

  /**
   * Get a handle to an existing standalone Nexus operation.
   *
   * If {@link GetNexusOperationHandleOptions.runId} is not provided, operations on the handle
   * (like {@link NexusOperationHandle.result}) will target the latest run.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  public getHandle<T>(
    operationId: string,
    options?: GetNexusOperationHandleOptions
  ): NexusOperationHandle<NexusOperationHandleResult<T>>;
  public getHandle(operationId: string, options?: GetNexusOperationHandleOptions): NexusOperationHandle {
    return this.createNexusOperationHandle({
      operationId,
      runId: options?.runId,
    });
  }

  /**
   * List standalone Nexus operations matching a visibility query.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  public list(options?: ListNexusOperationsOptions): AsyncIterable<NexusOperationExecution> {
    const input: ListNexusOperationsInput = {
      query: options?.query,
      pageSize: options?.pageSize,
    };
    const next = this.listHandler.bind(this);
    const list = composeInterceptors(this.interceptors, 'list', next);
    return list(input);
  }

  /**
   * Count standalone Nexus operations matching a visibility query.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  public async count(query?: string): Promise<NexusOperationExecutionCount> {
    const input: CountNexusOperationsInput = { query };
    const next = this.countHandler.bind(this);
    const count = composeInterceptors(this.interceptors, 'count', next);
    return await count(input);
  }

  protected async startNexusOperation(input: StartNexusOperationInput): Promise<NexusOperationHandle> {
    const next = this.startNexusOperationHandler.bind(this);
    const start = composeInterceptors(this.interceptors, 'startOperation', next);
    return await start(input);
  }

  protected async getNexusOperationResult(input: GetNexusOperationResultInput): Promise<unknown> {
    const next = this.getResultHandler.bind(this);
    const get = composeInterceptors(this.interceptors, 'getResult', next);
    return await get(input);
  }

  protected async describeNexusOperation(
    input: DescribeNexusOperationInput
  ): Promise<NexusOperationExecutionDescription> {
    const next = this.describeHandler.bind(this);
    const describe = composeInterceptors(this.interceptors, 'describe', next);
    return await describe(input);
  }

  protected async cancelNexusOperation(input: CancelNexusOperationInput): Promise<void> {
    const next = this.cancelHandler.bind(this);
    const cancel = composeInterceptors(this.interceptors, 'cancel', next);
    await cancel(input);
  }

  protected async terminateNexusOperation(input: TerminateNexusOperationInput): Promise<void> {
    const next = this.terminateHandler.bind(this);
    const terminate = composeInterceptors(this.interceptors, 'terminate', next);
    await terminate(input);
  }

  protected async startNexusOperationHandler(input: StartNexusOperationInput): Promise<NexusOperationHandle> {
    const inputPayload = await encodeToPayload(this.dataConverter, input.arg);
    const searchAttributes =
      input.searchAttributes != null
        ? { indexedFields: encodeUnifiedSearchAttributes(undefined, input.searchAttributes) }
        : undefined;
    const userMetadata =
      input.summary != null
        ? {
            summary: await encodeToPayload(this.dataConverter, input.summary),
          }
        : undefined;
    const req: temporal.api.workflowservice.v1.IStartNexusOperationExecutionRequest = {
      namespace: this.options.namespace,
      identity: this.options.identity,
      requestId: uuid4(),
      operationId: input.id,
      endpoint: input.endpoint,
      service: input.service,
      operation: input.operation,
      scheduleToCloseTimeout: msOptionalToTs(input.scheduleToCloseTimeout),
      scheduleToStartTimeout: msOptionalToTs(input.scheduleToStartTimeout),
      startToCloseTimeout: msOptionalToTs(input.startToCloseTimeout),
      input: inputPayload,
      idReusePolicy: input.idReusePolicy != null ? encodeNexusOperationIdReusePolicy(input.idReusePolicy) : undefined,
      idConflictPolicy:
        input.idConflictPolicy != null ? encodeNexusOperationIdConflictPolicy(input.idConflictPolicy) : undefined,
      searchAttributes,
      nexusHeader: input.headers ?? {},
      userMetadata,
    };
    let res: temporal.api.workflowservice.v1.IStartNexusOperationExecutionResponse;
    try {
      res = await this.connection.workflowService.startNexusOperationExecution(req);
    } catch (err: unknown) {
      this.rethrowGrpcError(err, 'Failed to start Nexus operation', input.id);
    }
    return this.createNexusOperationHandle({
      operationId: input.id,
      runId: res.runId ?? undefined,
    });
  }

  protected createNexusOperationHandle<O>(opts: { operationId: string; runId?: string }): NexusOperationHandle<O> {
    let cachedResult:
      | { state: 'not-requested' }
      | { state: 'success'; value: O }
      | { state: 'failed'; failure: NexusOperationFailureError } = { state: 'not-requested' };
    return {
      operationId: opts.operationId,
      runId: opts.runId,
      client: this,
      async result(): Promise<O> {
        if (cachedResult.state === 'not-requested') {
          try {
            const result = (await this.client.getNexusOperationResult({
              operationId: this.operationId,
              runId: this.runId,
            })) as O;
            cachedResult = { state: 'success', value: result };
            return result;
          } catch (err) {
            if (err instanceof NexusOperationFailureError) {
              cachedResult = { state: 'failed', failure: err };
            }
            throw err;
          }
        } else if (cachedResult.state === 'success') {
          return cachedResult.value;
        } else {
          throw cachedResult.failure;
        }
      },
      async describe(_options?: DescribeNexusOperationOptions): Promise<NexusOperationExecutionDescription> {
        return await this.client.describeNexusOperation({
          operationId: this.operationId,
          runId: this.runId,
        });
      },
      async cancel(reason?: string): Promise<void> {
        return await this.client.cancelNexusOperation({
          operationId: this.operationId,
          runId: this.runId,
          reason,
        });
      },
      async terminate(reason?: string): Promise<void> {
        return await this.client.terminateNexusOperation({
          operationId: this.operationId,
          runId: this.runId,
          reason,
        });
      },
    };
  }

  protected async getResultHandler(input: GetNexusOperationResultInput): Promise<unknown> {
    const req: temporal.api.workflowservice.v1.IPollNexusOperationExecutionRequest = {
      namespace: this.options.namespace,
      operationId: input.operationId,
      runId: input.runId ?? '',
      waitStage: temporal.api.enums.v1.NexusOperationWaitStage.NEXUS_OPERATION_WAIT_STAGE_CLOSED,
    };
    for (;;) {
      let res: temporal.api.workflowservice.v1.IPollNexusOperationExecutionResponse;
      try {
        res = await this.connection.workflowService.pollNexusOperationExecution(req);
      } catch (err: unknown) {
        this.rethrowGrpcError(err, 'Failed to poll Nexus operation result', input.operationId);
      }

      // The operation is closed if we have a result or failure
      if (res.result) {
        return await decodeFromPayloadsAtIndex(this.dataConverter, 0, [res.result]);
      }
      if (res.failure) {
        const cause = await decodeOptionalFailureToOptionalError(this.dataConverter, res.failure);
        throw new NexusOperationFailureError(
          `Nexus operation failed: ${res.failure.message ?? 'unknown failure'}`,
          cause ?? new Error(res.failure.message ?? 'unknown failure')
        );
      }
    }
  }

  protected async describeHandler(input: DescribeNexusOperationInput): Promise<NexusOperationExecutionDescription> {
    const req: temporal.api.workflowservice.v1.IDescribeNexusOperationExecutionRequest = {
      namespace: this.options.namespace,
      operationId: input.operationId,
      runId: input.runId ?? '',
    };
    let res: temporal.api.workflowservice.v1.IDescribeNexusOperationExecutionResponse;
    try {
      res = await this.connection.workflowService.describeNexusOperationExecution(req);
    } catch (err: unknown) {
      this.rethrowGrpcError(err, 'Failed to describe Nexus operation', input.operationId);
    }
    if (!res.info) {
      throw new ServiceError('Received invalid Nexus operation description from server: missing info');
    }
    return await nexusOperationExecutionDescriptionFromProto(res.info, this.dataConverter);
  }

  protected async cancelHandler(input: CancelNexusOperationInput): Promise<void> {
    const req: temporal.api.workflowservice.v1.IRequestCancelNexusOperationExecutionRequest = {
      namespace: this.options.namespace,
      operationId: input.operationId,
      runId: input.runId ?? '',
      identity: this.options.identity,
      requestId: uuid4(),
      reason: input.reason,
    };
    try {
      await this.connection.workflowService.requestCancelNexusOperationExecution(req);
    } catch (err: unknown) {
      this.rethrowGrpcError(err, 'Failed to cancel Nexus operation', input.operationId);
    }
  }

  protected async terminateHandler(input: TerminateNexusOperationInput): Promise<void> {
    const req: temporal.api.workflowservice.v1.ITerminateNexusOperationExecutionRequest = {
      namespace: this.options.namespace,
      operationId: input.operationId,
      runId: input.runId ?? '',
      identity: this.options.identity,
      requestId: uuid4(),
      reason: input.reason,
    };
    try {
      await this.connection.workflowService.terminateNexusOperationExecution(req);
    } catch (err: unknown) {
      this.rethrowGrpcError(err, 'Failed to terminate Nexus operation', input.operationId);
    }
  }

  protected async *listHandler(input: ListNexusOperationsInput): AsyncIterable<NexusOperationExecution> {
    let nextPageToken: Uint8Array | undefined = undefined;
    for (;;) {
      let response: temporal.api.workflowservice.v1.IListNexusOperationExecutionsResponse;
      try {
        response = await this.connection.workflowService.listNexusOperationExecutions({
          namespace: this.options.namespace,
          query: input.query,
          pageSize: input.pageSize,
          nextPageToken,
        });
      } catch (err: unknown) {
        this.rethrowGrpcError(err, 'Failed to list Nexus operations', undefined);
      }
      for (const raw of response.operations ?? []) {
        yield nexusOperationListInfoFromProto(raw);
      }
      if (response.nextPageToken == null || response.nextPageToken.length === 0) break;
      nextPageToken = response.nextPageToken;
    }
  }

  protected async countHandler(input: CountNexusOperationsInput): Promise<NexusOperationExecutionCount> {
    try {
      const res = await this.connection.workflowService.countNexusOperationExecutions({
        namespace: this.options.namespace,
        query: input.query,
      });
      return nexusCountFromProto(res);
    } catch (err: unknown) {
      this.rethrowGrpcError(err, 'Failed to count Nexus operations', undefined);
    }
  }

  protected rethrowGrpcError(err: unknown, fallbackMessage: string, operationId?: string, runId?: string): never {
    if (isGrpcServiceError(err)) {
      rethrowKnownErrorTypes(err);

      if (err.code === grpcStatus.ALREADY_EXISTS && operationId != null) {
        throw new NexusOperationAlreadyStartedError(operationId, extractNexusOperationAlreadyStartedRunId(err));
      }

      if (err.code === grpcStatus.NOT_FOUND && operationId != null) {
        throw new NexusOperationNotFoundError(operationId, runId);
      }

      throw new ServiceError(fallbackMessage, { cause: err });
    }

    throw new ServiceError('Unexpected error while making gRPC request', { cause: err as Error });
  }
}

async function cancellationInfoFromProto(
  raw: RawNexusOperationExecutionCancellationInfo,
  dataConverter: LoadedDataConverter
): Promise<NexusOperationExecutionCancellationInfo> {
  return {
    requestedTime: optionalTsToDate(raw.requestedTime),
    state: decodeNexusOperationCancellationState(raw.state),
    attempt: raw.attempt ?? 0,
    lastAttemptCompleteTime: optionalTsToDate(raw.lastAttemptCompleteTime),
    nextAttemptScheduleTime: optionalTsToDate(raw.nextAttemptScheduleTime),
    lastAttemptFailure: await decodeOptionalFailureToOptionalError(dataConverter, raw.lastAttemptFailure),
    blockedReason: raw.blockedReason ?? undefined,
    reason: raw.reason ?? '',
    raw,
  };
}

async function nexusOperationExecutionDescriptionFromProto(
  raw: RawNexusOperationExecutionInfo,
  dataConverter: LoadedDataConverter
): Promise<NexusOperationExecutionDescription> {
  let decodedMetadata:
    | { state: 'pending' }
    | { state: 'requested'; value: Promise<{ summary: string | undefined; details: string | undefined }> } = {
    state: 'pending',
  };
  const decodeMetadata = async () => {
    if (decodedMetadata.state === 'pending') {
      const metadataPromise = Promise.all([
        decodeOptionalSinglePayload<string>(dataConverter, raw.userMetadata?.summary),
        decodeOptionalSinglePayload<string>(dataConverter, raw.userMetadata?.details),
      ]).then(([summary, details]) => {
        return {
          summary: summary ?? undefined,
          details: details ?? undefined,
        };
      });
      decodedMetadata = {
        state: 'requested',
        value: metadataPromise,
      };
    }
    return await decodedMetadata.value;
  };
  return {
    operationId: raw.operationId ?? '',
    runId: raw.runId ?? '',
    endpoint: raw.endpoint ?? '',
    service: raw.service ?? '',
    operation: raw.operation ?? '',
    status: decodeNexusOperationExecutionStatus(raw.status),
    state: decodePendingNexusOperationState(raw.state),
    scheduleToCloseTimeout: optionalTsToMs(raw.scheduleToCloseTimeout),
    scheduleToStartTimeout: optionalTsToMs(raw.scheduleToStartTimeout),
    startToCloseTimeout: optionalTsToMs(raw.startToCloseTimeout),
    attempt: raw.attempt ?? 0,
    scheduleTime: optionalTsToDate(raw.scheduleTime),
    expirationTime: optionalTsToDate(raw.expirationTime),
    closeTime: optionalTsToDate(raw.closeTime),
    lastAttemptCompleteTime: optionalTsToDate(raw.lastAttemptCompleteTime),
    lastAttemptFailure: await decodeOptionalFailureToOptionalError(dataConverter, raw.lastAttemptFailure),
    nextAttemptScheduleTime: optionalTsToDate(raw.nextAttemptScheduleTime),
    executionDuration: optionalTsToMs(raw.executionDuration),
    cancellationInfo: raw.cancellationInfo
      ? await cancellationInfoFromProto(raw.cancellationInfo, dataConverter)
      : undefined,
    blockedReason: raw.blockedReason ?? undefined,
    requestId: raw.requestId ?? '',
    operationToken: raw.operationToken ?? undefined,
    stateTransitionCount: raw.stateTransitionCount?.toNumber() ?? 0,
    searchAttributes: decodeTypedSearchAttributes(raw.searchAttributes?.indexedFields),
    identity: raw.identity ?? '',
    raw,
    staticDetails: async () => (await decodeMetadata()).details,
    staticSummary: async () => (await decodeMetadata()).summary,
  };
}

function nexusOperationListInfoFromProto(raw: RawNexusOperationExecutionListInfo): NexusOperationExecution {
  return {
    operationId: raw.operationId ?? '',
    runId: raw.runId ?? '',
    endpoint: raw.endpoint ?? '',
    service: raw.service ?? '',
    operation: raw.operation ?? '',
    scheduleTime: optionalTsToDate(raw.scheduleTime),
    closeTime: optionalTsToDate(raw.closeTime),
    status: decodeNexusOperationExecutionStatus(raw.status),
    searchAttributes: decodeTypedSearchAttributes(raw.searchAttributes?.indexedFields),
    stateTransitionCount: raw.stateTransitionCount?.toNumber() ?? 0,
    executionDuration: optionalTsToMs(raw.executionDuration),
    raw,
  };
}

function nexusCountFromProto(
  raw: temporal.api.workflowservice.v1.ICountNexusOperationExecutionsResponse
): NexusOperationExecutionCount {
  return {
    count: raw.count?.toNumber() ?? 0,
    groups: (raw.groups ?? []).map((group) => ({
      count: group.count?.toNumber() ?? 0,
      groupValues: (group.groupValues ?? []).map(decodeCountGroupValue),
    })),
  };
}

function decodeCountGroupValue(value: temporal.api.common.v1.IPayload): TypedSearchAttributeValue<SearchAttributeType> {
  const decoded = typedSearchAttributePayloadConverter.fromPayload<
    TypedSearchAttributeValue<SearchAttributeType> | undefined
  >(value);
  if (decoded === undefined) {
    throw new ServiceError(
      'Received invalid Nexus operation count group value from server: ' +
        `metadata.type=${decodePayloadMetadata(value.metadata?.type) ?? '<missing>'}, ` +
        `metadata.encoding=${decodePayloadMetadata(value.metadata?.encoding) ?? '<missing>'}`
    );
  }
  return decoded;
}

function decodePayloadMetadata(value: Uint8Array | null | undefined): string | undefined {
  return value == null ? undefined : decode(value);
}

/**
 * Thrown by {@link NexusOperationHandle.result} when the operation completes with a failure outcome.
 * The original failure is available on `cause`.
 */
@SymbolBasedInstanceOfError('NexusOperationFailureError')
export class NexusOperationFailureError extends Error {
  public constructor(
    message: string,
    public readonly cause: Error
  ) {
    super(message, { cause });
  }
}

/**
 * Thrown by {@link NexusServiceClient.startOperation} when the server returns ALREADY_EXISTS
 * because an operation with the given ID already exists and the reuse/conflict policies disallow reuse.
 */
@SymbolBasedInstanceOfError('NexusOperationAlreadyStartedError')
export class NexusOperationAlreadyStartedError extends Error {
  public constructor(
    public readonly operationId: string,
    public readonly runId?: string
  ) {
    super(`Nexus operation already started: operationId=${operationId}${runId ? ` runId=${runId}` : ''}`);
  }
}

/**
 * Thrown when a Nexus Operation with the given operationId and runId is not known by the Temporal Server.
 */
@SymbolBasedInstanceOfError('NexusOperationNotFoundError')
export class NexusOperationNotFoundError extends Error {
  public constructor(
    public readonly operationId: string,
    public readonly runId?: string
  ) {
    super(`Nexus operation not found: operationId=${operationId}${runId ? ` runId=${runId}` : ''}`);
  }
}
