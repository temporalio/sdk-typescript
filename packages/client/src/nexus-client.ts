import { status as grpcStatus } from '@grpc/grpc-js';
import type * as nexus from 'nexus-rpc';
import { v4 as uuid4 } from 'uuid';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { SymbolBasedInstanceOfError } from '@temporalio/common/lib/type-helpers';
import {
  decodeTypedSearchAttributes,
  encodeUnifiedSearchAttributes,
  searchAttributePayloadConverter,
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
export interface NexusOperationHandle<O> {
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

type OperationInputOf<Op> = Op extends nexus.OperationDefinition<infer I, any> ? I : unknown;
type OperationOutputOf<Op> = Op extends nexus.OperationDefinition<any, infer O> ? O : unknown;

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
    input: OperationInputOf<Op>,
    options: StartNexusOperationOptions
  ): Promise<NexusOperationHandle<OperationOutputOf<Op>>>;
  startOperation<K extends keyof T['operations']>(
    operationKey: K,
    input: OperationInputOf<T['operations'][K]>,
    options: StartNexusOperationOptions
  ): Promise<NexusOperationHandle<OperationOutputOf<T['operations'][K]>>>;

  /**
   * Start a Nexus operation and wait for its result.
   *
   * Convenience for {@link startOperation} followed by {@link NexusOperationHandle.result}.
   *
   * @experimental Nexus Standalone Operations are experimental.
   */
  executeOperation<Op extends T['operations'][keyof T['operations']]>(
    operation: Op,
    input: OperationInputOf<Op>,
    options: StartNexusOperationOptions
  ): Promise<OperationOutputOf<Op>>;
  executeOperation<K extends keyof T['operations']>(
    operationKey: K,
    input: OperationInputOf<T['operations'][K]>,
    options: StartNexusOperationOptions
  ): Promise<OperationOutputOf<T['operations'][K]>>;
}

type CachedOperationResult<T> =
  | { kind: 'pending' }
  | { kind: 'complete'; value: T }
  | { kind: 'failed'; failure: NexusOperationFailureError };

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

    const startOperation = async (
      operation: unknown,
      input: unknown,
      options: StartNexusOperationOptions
    ): Promise<NexusOperationHandle<unknown>> => {
      const operationName = this._resolveOperationName(operation, service);
      return await this._startNexusOperation({
        endpoint,
        service: service.name,
        operation: operationName,
        arg: input,
        id: options.id,
        scheduleToCloseTimeout: options.scheduleToCloseTimeout,
        summary: options.summary,
        idReusePolicy: options.idReusePolicy,
        idConflictPolicy: options.idConflictPolicy,
        searchAttributes: options.searchAttributes,
        headers: options.headers,
      });
    };

    const executeOperation = async (
      operation: unknown,
      input: unknown,
      options: StartNexusOperationOptions
    ): Promise<unknown> => {
      const handle = await startOperation(operation, input, options);
      return await handle.result();
    };

    return {
      endpoint: options.endpoint,
      service: options.service,

      // need to cast from the widened signature
      // to the typesafe signature of the interface
      startOperation: startOperation as NexusServiceClient<T>['startOperation'],
      executeOperation: executeOperation as NexusServiceClient<T>['executeOperation'],
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
  public getHandle<O = unknown>(
    operationId: string,
    options?: GetNexusOperationHandleOptions
  ): NexusOperationHandle<O extends nexus.OperationDefinition<any, infer T> ? T : O> {
    return this._createNexusOperationHandle({
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
    const next = this._listHandler.bind(this);
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
    const next = this._countHandler.bind(this);
    const count = composeInterceptors(this.interceptors, 'count', next);
    return await count(input);
  }

  protected async _startNexusOperation(input: StartNexusOperationInput): Promise<NexusOperationHandle<unknown>> {
    const next = this._startNexusOperationHandler.bind(this);
    const start = composeInterceptors(this.interceptors, 'startOperation', next);
    return await start(input);
  }

  protected async _getNexusOperationResult(input: GetNexusOperationResultInput): Promise<unknown> {
    const next = this._getResultHandler.bind(this);
    const get = composeInterceptors(this.interceptors, 'getResult', next);
    return await get(input);
  }

  protected async _describeNexusOperation(
    input: DescribeNexusOperationInput
  ): Promise<NexusOperationExecutionDescription> {
    const next = this._describeHandler.bind(this);
    const describe = composeInterceptors(this.interceptors, 'describe', next);
    return await describe(input);
  }

  protected async _cancelNexusOperation(input: CancelNexusOperationInput): Promise<void> {
    const next = this._cancelHandler.bind(this);
    const cancel = composeInterceptors(this.interceptors, 'cancel', next);
    await cancel(input);
  }

  protected async _terminateNexusOperation(input: TerminateNexusOperationInput): Promise<void> {
    const next = this._terminateHandler.bind(this);
    const terminate = composeInterceptors(this.interceptors, 'terminate', next);
    await terminate(input);
  }

  protected async _startNexusOperationHandler(input: StartNexusOperationInput): Promise<NexusOperationHandle<unknown>> {
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
      this._handleStartError(err, input.id);
    }
    return this._createNexusOperationHandle({
      operationId: input.id,
      runId: res.runId ?? undefined,
    });
  }

  protected _createNexusOperationHandle<O>(opts: { operationId: string; runId?: string }): NexusOperationHandle<O> {
    let cachedResult: CachedOperationResult<O> = { kind: 'pending' };
    return {
      operationId: opts.operationId,
      runId: opts.runId,
      client: this,
      async result(): Promise<O> {
        switch (cachedResult.kind) {
          case 'pending': {
            try {
              const result = await this.client._getNexusOperationResult({
                operationId: this.operationId,
                runId: this.runId,
              });
              cachedResult = { kind: 'complete', value: result as O };
              return cachedResult.value;
            } catch (err) {
              if (err instanceof NexusOperationFailureError) {
                cachedResult = { kind: 'failed', failure: err };
              }
              throw err;
            }
          }
          case 'complete':
            return cachedResult.value;
          case 'failed':
            throw cachedResult.failure;
        }
      },
      async describe(options?: DescribeNexusOperationOptions): Promise<NexusOperationExecutionDescription> {
        return await this.client._describeNexusOperation({
          operationId: this.operationId,
          runId: this.runId,
          longPollToken: options?.longPollToken,
        });
      },
      async cancel(reason?: string): Promise<void> {
        return await this.client._cancelNexusOperation({
          operationId: this.operationId,
          runId: this.runId,
          reason,
        });
      },
      async terminate(reason?: string): Promise<void> {
        return await this.client._terminateNexusOperation({
          operationId: this.operationId,
          runId: this.runId,
          reason,
        });
      },
    };
  }

  protected _resolveOperationName(operation: unknown, service: nexus.ServiceDefinition): string {
    if (typeof operation === 'string') return operation;
    if (operation && typeof operation === 'object' && 'name' in operation) {
      return (operation as nexus.OperationDefinition<any, any>).name;
    }
    // Resolve by reference against the service's operations
    for (const [k, v] of Object.entries(service.operations)) {
      if (v === operation) return v.name ?? k;
    }
    throw new TypeError('Unable to resolve Nexus operation name');
  }

  protected async _getResultHandler(input: GetNexusOperationResultInput): Promise<unknown> {
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
        if (isGrpcServiceError(err) && err.code === grpcStatus.DEADLINE_EXCEEDED) {
          // Long-poll timed out without a terminal state. Retry.
          continue;
        }
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

      // Wait stage may be reported as less than CLOSED if long-poll returned early;
      // retry the poll.
      continue;
    }
  }

  protected async _describeHandler(input: DescribeNexusOperationInput): Promise<NexusOperationExecutionDescription> {
    const req: temporal.api.workflowservice.v1.IDescribeNexusOperationExecutionRequest = {
      namespace: this.options.namespace,
      operationId: input.operationId,
      runId: input.runId ?? '',
      longPollToken: input.longPollToken,
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
    return await nexusOperationExecutionDescriptionFromProto(
      res.info,
      this.dataConverter,
      res.longPollToken ?? undefined
    );
  }

  protected async _cancelHandler(input: CancelNexusOperationInput): Promise<void> {
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

  protected async _terminateHandler(input: TerminateNexusOperationInput): Promise<void> {
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

  protected async *_listHandler(input: ListNexusOperationsInput): AsyncIterable<NexusOperationExecution> {
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

  protected async _countHandler(input: CountNexusOperationsInput): Promise<NexusOperationExecutionCount> {
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

  /**
   * Handle errors from StartNexusOperationExecution: unpack ALREADY_EXISTS details and throw
   * {@link NexusOperationAlreadyStartedError} if applicable.
   */
  protected _handleStartError(err: unknown, operationId: string): never {
    if (isGrpcServiceError(err) && err.code === grpcStatus.ALREADY_EXISTS) {
      throw new NexusOperationAlreadyStartedError(operationId, extractNexusOperationAlreadyStartedRunId(err));
    }
    this.rethrowGrpcError(err, 'Failed to start Nexus operation', operationId);
  }

  protected rethrowGrpcError(err: unknown, fallbackMessage: string, operationId?: string, runId?: string): never {
    if (isGrpcServiceError(err)) {
      rethrowKnownErrorTypes(err);

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
  dataConverter: LoadedDataConverter,
  longPollToken: Uint8Array | undefined
): Promise<NexusOperationExecutionDescription> {
  let decodedMetadata:
    | { state: 'resolved'; summary: string | undefined; details: string | undefined }
    | { state: 'pending' } = {
    state: 'pending',
  };
  const decodeMetadata = async () => {
    if (decodedMetadata.state === 'pending') {
      decodedMetadata = {
        state: 'resolved',
        summary: (await decodeOptionalSinglePayload(dataConverter, raw.userMetadata?.summary)) ?? undefined,
        details: (await decodeOptionalSinglePayload(dataConverter, raw.userMetadata?.details)) ?? undefined,
      };
    }
    return decodedMetadata;
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
    longPollToken,
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
      groupValues: (group.groupValues ?? []).map((v) => searchAttributePayloadConverter.fromPayload(v)),
    })),
  };
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
 * because an operation with the given ID already exists (and the reuse/conflict policies disallow reuse.
 */
@SymbolBasedInstanceOfError('NexusOperationAlreadyStartedError')
export class NexusOperationAlreadyStartedError extends Error {
  public constructor(
    public readonly operationId: string,
    public readonly runId?: string
  ) {
    super(`Nexus operation already started: operation_id=${operationId} run_id=${runId}`);
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
    super(`Nexus operation not found: operation_id=${operationId} run_id=${runId}`);
  }
}
