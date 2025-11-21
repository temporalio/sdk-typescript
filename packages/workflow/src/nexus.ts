import * as nexus from 'nexus-rpc';
import { msOptionalToTs } from '@temporalio/common/lib/time';
import { userMetadataToPayload } from '@temporalio/common/lib/user-metadata';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
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
      const opName = typeof operation === 'string' ? options.service.operations[operation]?.name : operation.name;

      const activator = getActivator();
      const seq = activator.nextSeqs.nexusOperation++;

      const execute = composeInterceptors(
        activator.interceptors.outbound,
        'startNexusOperation',
        startNexusOperationNextHandler
      );

      // TODO: Do we want to make the interceptor async like we do for child workflow? That seems redundant.
      // REVIEW: I ended up changing this so that the interceptor returns a Promise<StartNexusOperationOutput>,
      //         and the result promise is contained in that Output object. As a consequence of this,
      //         the result promise/completion does not exist until the StartNexusOperation event is received.
      //         That's totally different from what we did in ChildWorkflow, but I think that's cleaner from
      //         interceptors point of view, and will make it easier to extend the API in the future.
      const { token, result: resultPromise } = await execute({
        endpoint: options.endpoint,
        service: options.service.name,
        operation: opName,
        options: operationOptions ?? {},
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
        // FIXME(nexus-post-initial-release): cancellationType is not supported yet
      },
      userMetadata: userMetadataToPayload(activator.payloadConverter, options?.summary, undefined),
    });

    activator.completions.nexusOperationStart.set(seq, {
      resolve,
      reject,
    });
  });
}
