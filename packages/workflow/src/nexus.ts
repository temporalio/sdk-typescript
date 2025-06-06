import * as nexus from 'nexus-rpc';
import { msOptionalToTs } from '@temporalio/common/lib/time';
import { CancellationScope } from './cancellation-scope';
import { getActivator } from './global-attributes';
import { StartNexusOperationOptions } from './interfaces';
import { untrackPromise } from './stack-helpers';
import { StartNexusOperationInput, StartNexusOperationOutput } from './interceptors';

export interface NexusClient<T extends nexus.Service> {
  /**
   * Start a Nexus Operation and wait for its completion taking a {@link nexus.operation}.
   */
  executeOperation<O extends T['operations'][keyof T['operations']]>(
    op: O,
    input: nexus.OperationInput<O>,
    options?: Partial<StartNexusOperationOptions>
  ): Promise<nexus.OperationOutput<O>>;

  /**
   * Start a Nexus Operation and wait for its completion taking an operation name.
   */
  executeOperation<K extends nexus.OperationKey<T['operations']>>(
    op: K,
    input: nexus.OperationInput<T['operations'][K]>,
    options?: Partial<StartNexusOperationOptions>
  ): Promise<nexus.OperationOutput<T['operations'][K]>>;

  /**
   * Start a Nexus Operation taking a {@link nexus.operation}.
   *
   * Returns a handle that can be used to wait for the operation's result.
   */
  startOperation<O extends T['operations'][keyof T['operations']]>(
    op: O,
    input: nexus.OperationInput<O>,
    options?: Partial<StartNexusOperationOptions>
  ): Promise<NexusOperationHandle<nexus.OperationOutput<O>>>;

  /**
   * Start a Nexus Operation taking an operation name.
   *
   * Returns a handle that can be used to wait for the operation's result.
   */
  startOperation<K extends nexus.OperationKey<T['operations']>>(
    op: K,
    input: nexus.OperationInput<T['operations'][K]>,
    options?: Partial<StartNexusOperationOptions>
  ): Promise<NexusOperationHandle<nexus.OperationOutput<T['operations'][K]>>>;
}

/**
 * A handle to a Nexus Operation.
 */
export interface NexusOperationHandle<T> {
  /**
   * The operation's service name.
   */
  readonly service: string;
  /**
   * The name of the Operation.
   */
  readonly operation: string;
  /**
   * Operation token as set by the Operation's handler. May be empty if the operation completed synchronously.
   */
  readonly token?: string;

  /**
   * Wait for Operation completion and get its result.
   */
  result(): Promise<T>;
}

/**
 * Options for {@createNexusClient}.
 */
interface NexusClientOptions<T> {
  endpoint: string;
  service: T;
}

/**
 * Create a Nexus client for invoking Nexus Operations from a Workflow.
 */
export function createNexusClient<T extends nexus.Service>(options: NexusClientOptions<T>): NexusClient<T> {
  const client = {
    executeOperation: async (operation: any, input: unknown, operationOptions?: StartNexusOperationOptions) => {
      const handle = await client.startOperation(operation, input, operationOptions);
      return await handle.result();
    },
    startOperation: async (
      operation: string | nexus.Operation<any, any>,
      input: unknown,
      operationOptions?: StartNexusOperationOptions
    ) => {
      const opName = typeof operation === 'string' ? options.service.operations[operation].name : operation.name;

      const activator = getActivator();
      const seq = activator.nextSeqs.nexusOperation++;

      // TODO: Do we want to make the interceptor async like we do for child workflow? That seems redundant.
      const [startPromise, completePromise] = startNexusOperationNextHandler({
        endpoint: options.endpoint,
        service: options.service.name,
        operation: opName,
        options: operationOptions ?? {},
        nexusHeader: {},
        seq,
        input,
      });
      const { token } = await startPromise;
      return {
        service: options.service.name,
        operation: opName,
        token,
        async result() {
          return await completePromise;
        },
      };
    },
  };
  return client as any;
}

export function startNexusOperationNextHandler({
  input,
  endpoint,
  service,
  options,
  operation,
  seq,
  nexusHeader,
}: StartNexusOperationInput): [Promise<StartNexusOperationOutput>, Promise<unknown>] {
  const activator = getActivator();
  const startPromise = new Promise<StartNexusOperationOutput>((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }
    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch(() => {
          const complete = !activator.completions.nexusOperationComplete.has(seq);

          if (!complete) {
            activator.pushCommand({
              requestCancelNexusOperation: { seq },
            });
          }
          // Nothing to cancel otherwise
        })
      );
    }

    getActivator().pushCommand({
      scheduleNexusOperation: {
        seq,
        endpoint,
        service,
        operation,
        nexusHeader,
        input: activator.payloadConverter.toPayload(input),
        scheduleToCloseTimeout: msOptionalToTs(options?.scheduleToCloseTimeout),
      },
    });
    activator.completions.nexusOperationStart.set(seq, {
      resolve,
      reject,
    });
  });

  const completePromise = new Promise((resolve, reject) => {
    activator.completions.nexusOperationComplete.set(seq, {
      resolve,
      reject,
    });
  });
  untrackPromise(startPromise);
  untrackPromise(completePromise);
  // Prevent unhandled rejection because the completion might not be awaited
  untrackPromise(completePromise.catch(() => undefined));
  return [startPromise, completePromise];
}
