import * as nexus from 'nexus-rpc';
import { msOptionalToTs } from '@temporalio/common/lib/time';
import { userMetadataToPayload } from '@temporalio/common/lib/user-metadata';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { makeProtoEnumConverters } from '@temporalio/common/lib/internal-workflow/enums-helpers';
import type { coresdk } from '@temporalio/proto';
import { CancellationScope } from './cancellation-scope';
import { getActivator } from './global-attributes';
import { untrackPromise } from './stack-helpers';
import { StartNexusOperationInput, StartNexusOperationOutput, StartNexusOperationOptions } from './interceptors';

/**
 * A Nexus client for invoking Nexus Operations for a specific service from a Workflow.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface NexusClient<T extends nexus.ServiceDefinition> {
  /**
   * Start a Nexus Operation and wait for its completion taking a {@link nexus.operation}.
   * Returns the operation's result.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  executeOperation<O extends T['operations'][keyof T['operations']]>(
    op: O,
    input: nexus.OperationInput<O>,
    options?: Partial<StartNexusOperationOptions>
  ): Promise<nexus.OperationOutput<O>>;

  // TODO(nexus/post-initial-release): Revisit the "Operation Property Name" terminology,
  //                                   and reflect in the Nexus RPC SDK.

  /**
   * Start a Nexus Operation and wait for its completion, taking an Operation's _property name_.
   * Returns the operation's result.
   *
   * An Operation's _property name_ is the name of the property used to define that Operation in
   * the {@link nexus.ServiceDefinition} object; it may differ from the value of the `name` property
   * if one was explicitly specified on the {@link nexus.OperationDefinition} object.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  executeOperation<K extends nexus.OperationKey<T['operations']>>(
    op: K,
    input: nexus.OperationInput<T['operations'][K]>,
    options?: Partial<StartNexusOperationOptions>
  ): Promise<nexus.OperationOutput<T['operations'][K]>>;

  /**
   * Start a Nexus Operation taking a {@link nexus.operation}.
   *
   * Returns a handle that can be used to wait for the Operation's result.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  startOperation<O extends T['operations'][keyof T['operations']]>(
    op: O,
    input: nexus.OperationInput<O>,
    options?: Partial<StartNexusOperationOptions>
  ): Promise<NexusOperationHandle<nexus.OperationOutput<O>>>;

  /**
   * Start a Nexus Operation, taking an Operation's _property name_.
   * Returns a handle that can be used to wait for the Operation's result.
   *
   * An Operation's _property name_ is the name of the property used to define that Operation in
   * the {@link nexus.ServiceDefinition} object; it may differ from the value of the `name` property
   * if one was explicitly specified on the {@link nexus.OperationDefinition} object.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  startOperation<K extends nexus.OperationKey<T['operations']>>(
    op: K,
    input: nexus.OperationInput<T['operations'][K]>,
    options?: Partial<StartNexusOperationOptions>
  ): Promise<NexusOperationHandle<nexus.OperationOutput<T['operations'][K]>>>;
}

/**
 * A handle to a Nexus Operation.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface NexusOperationHandle<T> {
  /**
   * The Operation's service name.
   */
  readonly service: string;

  /**
   * The name of the Operation.
   */
  readonly operation: string;

  /**
   * Operation token as set by the Operation's handler. May be empty if the Operation completed synchronously.
   */
  readonly token?: string;

  /**
   * Wait for Operation completion and get its result.
   */
  result(): Promise<T>;
}

/**
 * Options for {@link createNexusClient}.
 */
export interface NexusClientOptions<T> {
  endpoint: string;
  service: T;
}

/**
 * Create a Nexus client for invoking Nexus Operations from a Workflow.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export function createNexusClient<T extends nexus.ServiceDefinition>(options: NexusClientOptions<T>): NexusClient<T> {
  class NexusClientImpl<T extends nexus.ServiceDefinition> implements NexusClient<T> {
    async executeOperation<O extends T['operations'][keyof T['operations']]>(
      operation: string | T['operations'][nexus.OperationKey<T['operations']>],
      input: nexus.OperationInput<T['operations'][nexus.OperationKey<T['operations']>]>,
      operationOptions?: Partial<StartNexusOperationOptions>
    ): Promise<nexus.OperationOutput<O>> {
      const handle = await this.startOperation(operation, input, operationOptions);
      return await handle.result();
    }

    async startOperation<O extends T['operations'][keyof T['operations']]>(
      operation: string | T['operations'][nexus.OperationKey<T['operations']>],
      input: nexus.OperationInput<T['operations'][nexus.OperationKey<T['operations']>]>,
      operationOptions?: StartNexusOperationOptions
    ) {
      const opName =
        typeof operation === 'string'
          ? // Casting as string to cover up the fact that `opName` might be undefined.
            // If this happens, then `execute` will produce a `NexusOperationFailure.NOT_FOUND`.
            (options.service.operations[operation]?.name as string)
          : operation.name;

      const activator = getActivator();
      const seq = activator.nextSeqs.nexusOperation++;

      const execute = composeInterceptors(
        activator.interceptors.outbound,
        'startNexusOperation',
        startNexusOperationNextHandler
      );

      // The interceptor returns a Promise<StartNexusOperationOutput>, with the result promise contained
      // in that Output object. As a consequence of this, the result promise/completion does not exist
      // until the StartNexusOperation event is received. This is totally different from what we did in
      // ChildWorkflow, but is much cleaner from the interceptors point of view.
      const { token, result: resultPromise } = await execute({
        endpoint: options.endpoint,
        service: options.service.name,
        operation: opName,
        options: {
          ...operationOptions,
          cancellationType: operationOptions?.cancellationType ?? 'WAIT_CANCELLATION_COMPLETED',
        },
        headers: {},
        seq,
        input,
      });

      return {
        service: options.service.name,
        operation: opName,
        token,
        async result(): Promise<nexus.OperationOutput<O>> {
          return resultPromise as nexus.OperationOutput<O>;
        },
      };
    }
  }

  return new NexusClientImpl<T>();
}

function startNexusOperationNextHandler({
  input,
  endpoint,
  service,
  options,
  operation,
  seq,
  headers,
}: StartNexusOperationInput): Promise<StartNexusOperationOutput> {
  const activator = getActivator();

  return new Promise<StartNexusOperationOutput>((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }
    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch(() => {
          const completed =
            !activator.completions.nexusOperationStart.has(seq) &&
            !activator.completions.nexusOperationComplete.has(seq);

          if (!completed) {
            activator.pushCommand({
              requestCancelNexusOperation: { seq },
            });
          }

          // Nothing to cancel otherwise
        })
      );
    }

    activator.pushCommand({
      scheduleNexusOperation: {
        seq,
        endpoint,
        service,
        operation,
        nexusHeader: headers,
        input: activator.payloadConverter.toPayload(input),
        scheduleToCloseTimeout: msOptionalToTs(options?.scheduleToCloseTimeout),
        cancellationType: encodeNexusOperationCancellationType(options?.cancellationType),
      },
      userMetadata: userMetadataToPayload(activator.payloadConverter, options?.summary, undefined),
    });

    activator.completions.nexusOperationStart.set(seq, {
      resolve,
      reject,
    });
  });
}

/**
 * Determines:
 * - whether cancellation requests should be propagated from the Workflow to the Nexus Operation
 * - whether and when should the Operation's cancellation be reported back to the Workflow
 *   (i.e. at which moment should the operation's result promise fail with a `NexusOperationFailure`,
 *   with `cause` set to a `CancelledFailure`).
 *
 * Note that this setting only applies to cancellation originating from an external request for the
 * Workflow itself, or from internal cancellation of the `CancellationScope` in which the
 * Operation call was made.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
// MAINTENANCE: Keep this typedoc in sync with the `StartNexusOperationOptions.cancellationType` field
export const NexusOperationCancellationType = {
  /**
   * Do not propagate cancellation requests to the Nexus Operation, and immediately report
   * cancellation to the caller.
   */
  ABANDON: 'ABANDON',

  /**
   * Initiate a cancellation request for the Nexus operation and immediately report cancellation to
   * the caller. Note that it doesn't guarantee that cancellation is delivered to the operation if
   * calling workflow exits before the delivery is done. If you want to ensure that cancellation is
   * delivered to the operation, use {@link WAIT_CANCELLATION_REQUESTED}.
   *
   * Propagate cancellation request from the Workflow to the Operation, yet _immediately_ report
   * cancellation to the caller, i.e. without waiting for the server to confirm the cancellation
   * request.
   *
   * Note that this cancellation type provides no guarantee, from the Workflow-side, that the
   * cancellation request will be delivered to the Operation Handler. In particular, either the
   * Operation or the Workflow may complete (either successfully or uncessfully) before the
   * cancellation request is delivered, resulting in a situation where the Operation completed
   * successfully, but the Workflow thinks it was cancelled.
   *
   * To guarantee that the Operation will eventually be notified of the cancellation request,
   * use {@link WAIT_CANCELLATION_REQUESTED}.
   */
  TRY_CANCEL: 'TRY_CANCEL',

  /**
   * Propagate cancellation request from the Workflow to the Operation, then wait for the server
   * to confirm that the Operation cancellation request was delivered to the Operation Handler.
   */
  WAIT_CANCELLATION_REQUESTED: 'WAIT_CANCELLATION_REQUESTED',

  /**
   * Propagate cancellation request from the Workflow to the Operation, then wait for completion
   * of the Operation.
   */
  WAIT_CANCELLATION_COMPLETED: 'WAIT_CANCELLATION_COMPLETED',
} as const;
export type NexusOperationCancellationType =
  (typeof NexusOperationCancellationType)[keyof typeof NexusOperationCancellationType];

const [encodeNexusOperationCancellationType, _] = makeProtoEnumConverters<
  coresdk.nexus.NexusOperationCancellationType,
  typeof coresdk.nexus.NexusOperationCancellationType,
  keyof typeof coresdk.nexus.NexusOperationCancellationType,
  typeof NexusOperationCancellationType,
  ''
>(
  {
    [NexusOperationCancellationType.WAIT_CANCELLATION_COMPLETED]: 0,
    [NexusOperationCancellationType.ABANDON]: 1,
    [NexusOperationCancellationType.TRY_CANCEL]: 2,
    [NexusOperationCancellationType.WAIT_CANCELLATION_REQUESTED]: 3,
  } as const,
  ''
);
