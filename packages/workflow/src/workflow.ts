import {
  ActivityFunction,
  ActivityOptions,
  ContinueAsNew,
  ContinueAsNewOptions,
  ExternalDependencies,
  RemoteActivityOptions,
  Workflow,
  WorkflowInfo,
} from './interfaces';
import { state } from './internals';
import { IllegalStateError } from './errors';
import { msToTs, msOptionalStrToTs } from './time';
import { ActivityInput, TimerInput, composeInterceptors } from './interceptors';
import { CancellationScope, registerSleepImplementation } from './cancellation-scope';

// Avoid a circular dependency
registerSleepImplementation(sleep);

/**
 * Push a startTimer command into state accumulator and register completion
 */
function timerNextHandler(input: TimerInput) {
  return new Promise<void>((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      scope.cancelRequested.catch(reject);
      return;
    }
    if (scope.cancellable) {
      scope.cancelRequested.catch((err) => {
        if (!state.completions.delete(input.seq)) {
          return; // Already resolved
        }
        state.commands.push({
          cancelTimer: {
            timerId: `${input.seq}`,
          },
        });
        reject(err);
      });
    }
    state.completions.set(input.seq, {
      resolve,
      reject,
    });
    state.commands.push({
      startTimer: {
        timerId: `${input.seq}`,
        startToFireTimeout: msToTs(input.durationMs),
      },
    });
  });
}

/**
 * Asynchronous sleep.
 *
 * Schedules a timer on the Temporal service.
 * The returned promise is {@link cancel | cancellable}.
 *
 * @param ms milliseconds to sleep for
 */
export function sleep(ms: number): Promise<void> {
  const seq = state.nextSeq++;

  const execute = composeInterceptors(state.interceptors.outbound, 'startTimer', timerNextHandler);

  return execute({
    durationMs: ms,
    seq,
  });
}

export interface ActivityInfo {
  name: string;
  type: string;
}

export type InternalActivityFunction<P extends any[], R> = ActivityFunction<P, R> & ActivityInfo;

/**
 * @hidden
 */
export function validateActivityOptions(options: ActivityOptions): asserts options is RemoteActivityOptions {
  if (options.type === 'local') {
    throw new TypeError('local activity is not yet implemented');
  }

  if (options.scheduleToCloseTimeout === undefined && options.startToCloseTimeout === undefined) {
    throw new TypeError('Required either scheduleToCloseTimeout or startToCloseTimeout');
  }
}

/**
 * Push a scheduleActivity command into state accumulator and register completion
 */
async function scheduleActivityNextHandler({
  options,
  args,
  headers,
  seq,
  activityType,
}: ActivityInput): Promise<unknown> {
  validateActivityOptions(options);
  const argsAsPayloads = await state.dataConverter.toPayloads(...args);
  return new Promise((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      scope.cancelRequested.catch(reject);
      return;
    }
    if (scope.cancellable) {
      scope.cancelRequested.catch(() => {
        state.commands.push({
          requestCancelActivity: {
            activityId: `${seq}`,
          },
        });
      });
    }
    state.completions.set(seq, {
      resolve,
      reject,
    });
    state.commands.push({
      scheduleActivity: {
        activityId: `${seq}`,
        activityType,
        arguments: argsAsPayloads,
        retryPolicy: options.retry
          ? {
              maximumAttempts: options.retry.maximumAttempts,
              initialInterval: msOptionalStrToTs(options.retry.initialInterval),
              maximumInterval: msOptionalStrToTs(options.retry.maximumInterval),
              backoffCoefficient: options.retry.backoffCoefficient,
              // TODO: nonRetryableErrorTypes
            }
          : undefined,
        taskQueue: options.taskQueue || state.info?.taskQueue,
        heartbeatTimeout: msOptionalStrToTs(options.heartbeatTimeout),
        scheduleToCloseTimeout: msOptionalStrToTs(options.scheduleToCloseTimeout),
        startToCloseTimeout: msOptionalStrToTs(options.startToCloseTimeout),
        scheduleToStartTimeout: msOptionalStrToTs(options.scheduleToStartTimeout),
        namespace: options.namespace,
        headerFields: Object.fromEntries(headers.entries()),
      },
    });
  });
}

/**
 * Schedule an activity and run outbound interceptors
 * @hidden
 */
export function scheduleActivity<R>(
  activityType: string,
  args: any[],
  options: ActivityOptions | undefined = state.activityDefaults
): Promise<R> {
  if (options === undefined) {
    throw new TypeError('Got empty activity options');
  }
  const seq = state.nextSeq++;
  const execute = composeInterceptors(state.interceptors.outbound, 'scheduleActivity', scheduleActivityNextHandler);

  return execute({
    activityType: activityType,
    headers: new Map(),
    options,
    args,
    seq,
  }) as Promise<R>;
}

function activityInfo(activity: string | [string, string] | ActivityFunction<any, any>): ActivityInfo {
  if (typeof activity === 'string') {
    return { name: activity, type: activity };
  }
  if (activity instanceof Array) {
    return { name: activity[1], type: JSON.stringify(activity) };
  } else {
    return activity as InternalActivityFunction<any, any>;
  }
}

export class ContextImpl {
  /**
   * @protected
   */
  constructor() {
    // Does nothing just marks this as protected for documentation
  }
  /**
   * Configure an activity function with given {@link ActivityOptions}
   * Activities use the worker options's {@link WorkerOptions.activityDefaults | activityDefaults} unless configured otherwise.
   *
   * @typeparam P type of parameters of activity function, e.g `[string, string]` for `(a: string, b: string) => Promise<number>`
   * @typeparam R return type of activity function, e.g `number` for `(a: string, b: string) => Promise<number>`
   *
   * @param activity either an activity name if triggering an activity in another language, a tuple of [module, name] for untyped activities (e.g. ['@activities', 'greet']) or an imported activity function.
   * @param options partial {@link ActivityOptions} object, any attributes provided here override the provided activity's options
   *
   * @example
   * ```ts
   * import { Context } from '@temporalio/workflow';
   * import { httpGet } from '@activities';
   *
   * const httpGetWithCustomTimeout = Context.configure(httpGet, {
   *   type: 'remote',
   *   scheduleToCloseTimeout: '30 minutes',
   * });
   *
   * // Example of creating an activity from string
   * // Passing type parameters is optional, configured function will be untyped unless provided
   * const httpGetFromJava = Context.configure<[string, number], number>('SomeJavaMethod'); // Use worker activityDefaults when 2nd parameter is omitted
   *
   * export function main(): Promise<void> {
   *   const response = await httpGetWithCustomTimeout('http://example.com');
   *   // ...
   * }
   * ```
   */
  public configure<P extends any[], R>(
    activity: string | [string, string] | ActivityFunction<P, R>,
    options: ActivityOptions | undefined = state.activityDefaults
  ): ActivityFunction<P, R> {
    if (options === undefined) {
      throw new TypeError('options must be defined');
    }
    validateActivityOptions(options);
    const { name, type } = activityInfo(activity);
    // Wrap the function in an object so it gets the original function name
    const { [name]: fn } = {
      [name](...args: P) {
        return scheduleActivity<R>(type, args, options);
      },
    };
    const configured = fn as InternalActivityFunction<P, R>;
    Object.assign(configured, { type, options });
    return configured;
  }

  /**
   * Returns whether or not this workflow received a cancellation request.
   *
   * The workflow might still be running in case {@link CancelledError}s were caught.
   */
  public get cancelled(): boolean {
    return state.cancelled;
  }

  /**
   * Get information about the current Workflow
   */
  public get info(): WorkflowInfo {
    if (state.info === undefined) {
      throw new IllegalStateError('Workflow uninitialized');
    }
    return state.info;
  }

  /**
   * Get a reference to injected external dependencies.
   *
   * @example
   * ```ts
   * import { Context } from '@temporalio/workflow';
   * import { MyDependencies } from '../interfaces';
   *
   * const { logger } = Context.dependencies<MyDependencies>();
   * logger.info('setting up');
   *
   * export function main(): void {
   *  logger.info('hey ho');
   *  logger.error('lets go');
   * }
   * ```
   */
  public dependencies<T extends ExternalDependencies>(): T {
    return new Proxy(
      {},
      {
        get(_, ifaceName) {
          return new Proxy(
            {},
            {
              get(_, fnName) {
                return (...args: any[]) => {
                  if (state.info === undefined) {
                    throw new IllegalStateError('Workflow uninitialized');
                  }
                  return state.dependencies[ifaceName as string][fnName as string](...args);
                };
              },
            }
          );
        },
      }
    ) as any;
  }

  /**
   * Returns a function `f` that will cause the current Workflow to ContinueAsNew when called.
   *
   * `f` takes the same arguments as the Workflow main function supplied to typeparam `F`.
   *
   * Once `f` is called, Workflow execution immediately completes.
   */
  public makeContinueAsNewFunc<F extends Workflow['main']>(
    options?: ContinueAsNewOptions
  ): (...args: Parameters<F>) => Promise<never> {
    const nonOptionalOptions = { workflowType: state.info?.filename, taskQueue: state.info?.taskQueue, ...options };

    return (...args: Parameters<F>): Promise<never> => {
      const fn = composeInterceptors(state.interceptors.outbound, 'continueAsNew', async (input) => {
        const { headers, args, options } = input;
        throw new ContinueAsNew({
          workflowType: options.workflowType,
          arguments: await state.dataConverter.toPayloads(...args),
          header: Object.fromEntries(headers.entries()),
          taskQueue: options.taskQueue,
          memo: options.memo,
          searchAttributes: options.searchAttributes,
          workflowRunTimeout: msOptionalStrToTs(options.workflowRunTimeout),
          workflowTaskTimeout: msOptionalStrToTs(options.workflowTaskTimeout),
        });
      });
      return fn({
        args,
        headers: new Map(),
        options: nonOptionalOptions,
      });
    };
  }

  /**
   * Continues current Workflow execution as new with default options.
   *
   * Shorthand for `Context.makeContinueAsNewFunc<F>()(...args)`.
   *
   * @example
   *
   * ```ts
   * async function main(n: number) {
   *   // ... Workflow logic
   *   await Context.continueAsNew<typeof main>(n + 1);
   * }
   * ```
   */
  public continueAsNew<F extends Workflow['main']>(...args: Parameters<F>): Promise<never> {
    return this.makeContinueAsNewFunc()(...args);
  }
}

/**
 * Holds context of current running workflow
 */
export const Context: ContextImpl = new ContextImpl();

/**
 * Generate an RFC compliant V4 uuid.
 * Uses the workflow's deterministic PRNG making it safe for use within a workflow.
 * This function is cryptograpically insecure.
 * See the {@link https://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid | stackoverflow discussion}.
 */
export function uuid4(): string {
  // Return the hexadecimal text representation of number `n`, padded with zeroes to be of length `p`
  const ho = (n: number, p: number) => n.toString(16).padStart(p, '0');
  // Create a view backed by a 16-byte buffer
  const view = new DataView(new ArrayBuffer(16));
  // Fill buffer with random values
  view.setUint32(0, (Math.random() * 0x100000000) >>> 0);
  view.setUint32(4, (Math.random() * 0x100000000) >>> 0);
  view.setUint32(8, (Math.random() * 0x100000000) >>> 0);
  view.setUint32(12, (Math.random() * 0x100000000) >>> 0);
  // Patch the 6th byte to reflect a version 4 UUID
  view.setUint8(6, (view.getUint8(6) & 0xf) | 0x40);
  // Patch the 8th byte to reflect a variant 1 UUID (version 4 UUIDs are)
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  // Compile the canonical textual form from the array data
  return `${ho(view.getUint32(0), 8)}-${ho(view.getUint16(4), 4)}-${ho(view.getUint16(6), 4)}-${ho(
    view.getUint16(8),
    4
  )}-${ho(view.getUint32(10), 8)}${ho(view.getUint16(14), 4)}`;
}
