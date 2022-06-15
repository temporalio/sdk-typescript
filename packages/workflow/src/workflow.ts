import { mapToPayloads, searchAttributePayloadConverter, toPayloads } from '@temporalio/common';
import {
  ActivityFunction,
  ActivityInterface,
  ActivityOptions,
  compileRetryPolicy,
  composeInterceptors,
  IllegalStateError,
  LocalActivityOptions,
  msOptionalToTs,
  msToNumber,
  msToTs,
  QueryDefinition,
  SearchAttributes,
  SignalDefinition,
  tsToMs,
  WithWorkflowArgs,
  Workflow,
  WorkflowResultType,
  WorkflowReturnType,
} from '@temporalio/internal-workflow-common';
import { CancellationScope, registerSleepImplementation } from './cancellation-scope';
import {
  ActivityInput,
  LocalActivityInput,
  SignalWorkflowInput,
  StartChildWorkflowExecutionInput,
  TimerInput,
} from './interceptors';
import {
  ChildWorkflowCancellationType,
  ChildWorkflowOptions,
  ChildWorkflowOptionsWithDefaults,
  ContinueAsNew,
  ContinueAsNewOptions,
  WorkflowInfo,
} from './interfaces';
import { LocalActivityDoBackoff, state } from './internals';
import { Sinks } from './sinks';
import { untrackPromise } from './stack-helpers';
import { ChildWorkflowHandle, ExternalWorkflowHandle } from './workflow-handle';

// Avoid a circular dependency
registerSleepImplementation(sleep);

/**
 * Adds default values to `workflowId` and `workflowIdReusePolicy` to given workflow options.
 */
export function addDefaultWorkflowOptions<T extends Workflow>(
  opts: WithWorkflowArgs<T, ChildWorkflowOptions>
): ChildWorkflowOptionsWithDefaults {
  const { args, workflowId, ...rest } = opts;
  return {
    workflowId: workflowId ?? uuid4(),
    args: args ?? [],
    cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    ...rest,
  };
}

/**
 * Push a startTimer command into state accumulator and register completion
 */
function timerNextHandler(input: TimerInput) {
  return new Promise<void>((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }
    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch((err) => {
          if (!state.completions.timer.delete(input.seq)) {
            return; // Already resolved or never scheduled
          }
          state.pushCommand({
            cancelTimer: {
              seq: input.seq,
            },
          });
          reject(err);
        })
      );
    }
    state.pushCommand({
      startTimer: {
        seq: input.seq,
        startToFireTimeout: msToTs(input.durationMs),
      },
    });
    state.completions.timer.set(input.seq, {
      resolve,
      reject,
    });
  });
}

/**
 * Asynchronous sleep.
 *
 * Schedules a timer on the Temporal service.
 *
 * @param ms sleep duration - {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds.
 * If given a negative number or 0, value will be set to 1.
 */
export function sleep(ms: number | string): Promise<void> {
  const seq = state.nextSeqs.timer++;

  const durationMs = Math.max(1, msToNumber(ms));

  const execute = composeInterceptors(state.interceptors.outbound, 'startTimer', timerNextHandler);

  return execute({
    durationMs,
    seq,
  });
}

export interface ActivityInfo {
  name: string;
  type: string;
}

export type InternalActivityFunction<P extends any[], R> = ActivityFunction<P, R> & ActivityInfo;

function validateActivityOptions(options: ActivityOptions): void {
  if (options.scheduleToCloseTimeout === undefined && options.startToCloseTimeout === undefined) {
    throw new TypeError('Required either scheduleToCloseTimeout or startToCloseTimeout');
  }
}

// Use same validation we use for normal activities
const validateLocalActivityOptions = validateActivityOptions;

/**
 * Hooks up activity promise to current cancellation scope and completion callbacks.
 *
 * Returns `false` if the current scope is already cancelled.
 */
/**
 * Push a scheduleActivity command into state accumulator and register completion
 */
function scheduleActivityNextHandler({ options, args, headers, seq, activityType }: ActivityInput): Promise<unknown> {
  validateActivityOptions(options);
  return new Promise((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }
    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch(() => {
          if (!state.completions.activity.has(seq)) {
            return; // Already resolved or never scheduled
          }
          state.pushCommand({
            requestCancelActivity: {
              seq,
            },
          });
        })
      );
    }
    state.pushCommand({
      scheduleActivity: {
        seq,
        activityId: options.activityId ?? `${seq}`,
        activityType,
        arguments: toPayloads(state.payloadConverter, ...args),
        retryPolicy: options.retry ? compileRetryPolicy(options.retry) : undefined,
        taskQueue: options.taskQueue || state.info?.taskQueue,
        heartbeatTimeout: msOptionalToTs(options.heartbeatTimeout),
        scheduleToCloseTimeout: msOptionalToTs(options.scheduleToCloseTimeout),
        startToCloseTimeout: msOptionalToTs(options.startToCloseTimeout),
        scheduleToStartTimeout: msOptionalToTs(options.scheduleToStartTimeout),
        headers,
        cancellationType: options.cancellationType,
      },
    });
    state.completions.activity.set(seq, {
      resolve,
      reject,
    });
  });
}

/**
 * Push a scheduleActivity command into state accumulator and register completion
 */
async function scheduleLocalActivityNextHandler({
  options,
  args,
  headers,
  seq,
  activityType,
  attempt,
  originalScheduleTime,
}: LocalActivityInput): Promise<unknown> {
  validateLocalActivityOptions(options);

  return new Promise((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }
    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch(() => {
          if (!state.completions.activity.has(seq)) {
            return; // Already resolved or never scheduled
          }
          state.pushCommand({
            requestCancelLocalActivity: {
              seq,
            },
          });
        })
      );
    }
    state.pushCommand({
      scheduleLocalActivity: {
        seq,
        attempt,
        originalScheduleTime,
        // Intentionally not exposing activityId as an option
        activityId: `${seq}`,
        activityType,
        arguments: toPayloads(state.payloadConverter, ...args),
        retryPolicy: options.retry ? compileRetryPolicy(options.retry) : undefined,
        scheduleToCloseTimeout: msOptionalToTs(options.scheduleToCloseTimeout),
        startToCloseTimeout: msOptionalToTs(options.startToCloseTimeout),
        scheduleToStartTimeout: msOptionalToTs(options.scheduleToStartTimeout),
        localRetryThreshold: msOptionalToTs(options.localRetryThreshold),
        headers,
        cancellationType: options.cancellationType,
      },
    });
    state.completions.activity.set(seq, {
      resolve,
      reject,
    });
  });
}

/**
 * Schedule an activity and run outbound interceptors
 * @hidden
 */
export function scheduleActivity<R>(activityType: string, args: any[], options: ActivityOptions): Promise<R> {
  if (options === undefined) {
    throw new TypeError('Got empty activity options');
  }
  const seq = state.nextSeqs.activity++;
  const execute = composeInterceptors(state.interceptors.outbound, 'scheduleActivity', scheduleActivityNextHandler);

  return execute({
    activityType,
    headers: {},
    options,
    args,
    seq,
  }) as Promise<R>;
}

/**
 * Schedule an activity and run outbound interceptors
 * @hidden
 */
export async function scheduleLocalActivity<R>(
  activityType: string,
  args: any[],
  options: LocalActivityOptions
): Promise<R> {
  if (options === undefined) {
    throw new TypeError('Got empty activity options');
  }

  let attempt = 1;
  let originalScheduleTime = undefined;

  for (;;) {
    const seq = state.nextSeqs.activity++;
    const execute = composeInterceptors(
      state.interceptors.outbound,
      'scheduleLocalActivity',
      scheduleLocalActivityNextHandler
    );

    try {
      return (await execute({
        activityType,
        headers: {},
        options,
        args,
        seq,
        attempt,
        originalScheduleTime,
      })) as Promise<R>;
    } catch (err) {
      if (err instanceof LocalActivityDoBackoff) {
        await sleep(tsToMs(err.backoff.backoffDuration));
        if (typeof err.backoff.attempt !== 'number') {
          throw new TypeError('Invalid backoff attempt type');
        }
        attempt = err.backoff.attempt;
        originalScheduleTime = err.backoff.originalScheduleTime ?? undefined;
      } else {
        throw err;
      }
    }
  }
}

function startChildWorkflowExecutionNextHandler({
  options,
  headers,
  workflowType,
  seq,
}: StartChildWorkflowExecutionInput): Promise<[Promise<string>, Promise<unknown>]> {
  const workflowId = options.workflowId ?? uuid4();
  const startPromise = new Promise<string>((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }
    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch(() => {
          const complete = !state.completions.childWorkflowComplete.has(seq);
          const started = !state.completions.childWorkflowStart.has(seq);

          if (started && !complete) {
            const cancelSeq = state.nextSeqs.cancelWorkflow++;
            state.pushCommand({
              requestCancelExternalWorkflowExecution: {
                seq: cancelSeq,
                childWorkflowId: workflowId,
              },
            });
            // Not interested in this completion
            state.completions.cancelWorkflow.set(cancelSeq, { resolve: () => undefined, reject: () => undefined });
          } else if (!started) {
            state.pushCommand({
              cancelUnstartedChildWorkflowExecution: { childWorkflowSeq: seq },
            });
          }
          // Nothing to cancel otherwise
        })
      );
    }
    state.pushCommand({
      startChildWorkflowExecution: {
        seq,
        workflowId,
        workflowType,
        input: toPayloads(state.payloadConverter, ...options.args),
        retryPolicy: options.retry ? compileRetryPolicy(options.retry) : undefined,
        taskQueue: options.taskQueue || state.info?.taskQueue,
        workflowExecutionTimeout: msOptionalToTs(options.workflowExecutionTimeout),
        workflowRunTimeout: msOptionalToTs(options.workflowRunTimeout),
        workflowTaskTimeout: msOptionalToTs(options.workflowTaskTimeout),
        namespace: workflowInfo().namespace, // Not configurable
        headers,
        cancellationType: options.cancellationType,
        workflowIdReusePolicy: options.workflowIdReusePolicy,
        parentClosePolicy: options.parentClosePolicy,
        cronSchedule: options.cronSchedule,
        searchAttributes: options.searchAttributes
          ? mapToPayloads(searchAttributePayloadConverter, options.searchAttributes)
          : undefined,
        memo: options.memo && mapToPayloads(state.payloadConverter, options.memo),
      },
    });
    state.completions.childWorkflowStart.set(seq, {
      resolve,
      reject,
    });
  });

  // We construct a Promise for the completion of the child Workflow before we know
  // if the Workflow code will await it to capture the result in case it does.
  const completePromise = new Promise((resolve, reject) => {
    // Chain start Promise rejection to the complete Promise.
    untrackPromise(startPromise.catch(reject));
    state.completions.childWorkflowComplete.set(seq, {
      resolve,
      reject,
    });
  });
  untrackPromise(startPromise);
  untrackPromise(completePromise);
  // Prevent unhandled rejection because the completion might not be awaited
  untrackPromise(completePromise.catch(() => undefined));
  const ret = new Promise<[Promise<string>, Promise<unknown>]>((resolve) => resolve([startPromise, completePromise]));
  untrackPromise(ret);
  return ret;
}

function signalWorkflowNextHandler({ seq, signalName, args, target, headers }: SignalWorkflowInput) {
  return new Promise<any>((resolve, reject) => {
    if (state.info === undefined) {
      throw new IllegalStateError('Workflow uninitialized');
    }
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }

    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch(() => {
          if (!state.completions.signalWorkflow.has(seq)) {
            return;
          }
          state.pushCommand({ cancelSignalWorkflow: { seq } });
        })
      );
    }
    state.pushCommand({
      signalExternalWorkflowExecution: {
        seq,
        args: toPayloads(state.payloadConverter, ...args),
        headers,
        signalName,
        ...(target.type === 'external'
          ? {
              workflowExecution: {
                namespace: state.info.namespace,
                ...target.workflowExecution,
              },
            }
          : {
              childWorkflowId: target.childWorkflowId,
            }),
      },
    });

    state.completions.signalWorkflow.set(seq, { resolve, reject });
  });
}

/**
 * Configure Activity functions with given {@link ActivityOptions}.
 *
 * This method may be called multiple times to setup Activities with different options.
 *
 * @return a [Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy)
 *         for which each attribute is a callable Activity function
 *
 * @typeparam A An {@link ActivityInterface} - mapping of name to function
 *
 * @example
 * ```ts
 * import { proxyActivities, ActivityInterface } from '@temporalio/workflow';
 * import * as activities from '../activities';
 *
 * // Setup Activities from module exports
 * const { httpGet, otherActivity } = proxyActivities<typeof activities>({
 *   startToCloseTimeout: '30 minutes',
 * });
 *
 * // Setup Activities from an explicit interface (e.g. when defined by another SDK)
 * interface JavaActivities extends ActivityInterface {
 *   httpGetFromJava(url: string): Promise<string>
 *   someOtherJavaActivity(arg1: number, arg2: string): Promise<string>;
 * }
 *
 * const {
 *   httpGetFromJava,
 *   someOtherJavaActivity
 * } = proxyActivities<JavaActivities>({
 *   taskQueue: 'java-worker-taskQueue',
 *   startToCloseTimeout: '5m',
 * });
 *
 * export function execute(): Promise<void> {
 *   const response = await httpGet('http://example.com');
 *   // ...
 * }
 * ```
 */
export function proxyActivities<A extends ActivityInterface>(options: ActivityOptions): A {
  if (options === undefined) {
    throw new TypeError('options must be defined');
  }
  // Validate as early as possible for immediate user feedback
  validateActivityOptions(options);
  return new Proxy(
    {},
    {
      get(_, activityType) {
        if (typeof activityType !== 'string') {
          throw new TypeError(`Only strings are supported for Activity types, got: ${String(activityType)}`);
        }
        return function activityProxyFunction(...args: unknown[]): Promise<unknown> {
          return scheduleActivity(activityType, args, options);
        };
      },
    }
  ) as any;
}

/**
 * Configure Local Activity functions with given {@link LocalActivityOptions}.
 *
 * This method may be called multiple times to setup Activities with different options.
 *
 * @return a [Proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy)
 *         for which each attribute is a callable Activity function
 *
 * @typeparam A An {@link ActivityInterface} - mapping of name to function
 *
 * @experimental
 *
 * See {@link proxyActivities} for examples
 */
export function proxyLocalActivities<A extends ActivityInterface>(options: LocalActivityOptions): A {
  if (options === undefined) {
    throw new TypeError('options must be defined');
  }
  // Validate as early as possible for immediate user feedback
  validateLocalActivityOptions(options);
  return new Proxy(
    {},
    {
      get(_, activityType) {
        if (typeof activityType !== 'string') {
          throw new TypeError(`Only strings are supported for Activity types, got: ${String(activityType)}`);
        }
        return function localActivityProxyFunction(...args: unknown[]) {
          return scheduleLocalActivity(activityType, args, options);
        };
      },
    }
  ) as any;
}

// TODO: deprecate this patch after "enough" time has passed
const EXTERNAL_WF_CANCEL_PATCH = '__temporal_internal_connect_external_handle_cancel_to_scope';

/**
 * Returns a client-side handle that can be used to signal and cancel an existing Workflow execution.
 * It takes a Workflow ID and optional run ID.
 */
export function getExternalWorkflowHandle(workflowId: string, runId?: string): ExternalWorkflowHandle {
  return {
    workflowId,
    runId,
    cancel() {
      return new Promise<void>((resolve, reject) => {
        if (state.info === undefined) {
          throw new IllegalStateError('Uninitialized workflow');
        }

        // Connect this cancel operation to the current cancellation scope.
        // This is behavior was introduced after v0.22.0 and is incompatible
        // with histories generated with previous SDK versions and thus requires
        // patching.
        //
        // We try to delay patching as much as possible to avoid polluting
        // histories unless strictly required.
        const scope = CancellationScope.current();
        if (scope.cancellable) {
          untrackPromise(
            scope.cancelRequested.catch((err) => {
              if (patched(EXTERNAL_WF_CANCEL_PATCH)) {
                reject(err);
              }
            })
          );
        }
        if (scope.consideredCancelled) {
          if (patched(EXTERNAL_WF_CANCEL_PATCH)) {
            return;
          }
        }

        const seq = state.nextSeqs.cancelWorkflow++;
        state.pushCommand({
          requestCancelExternalWorkflowExecution: {
            seq,
            workflowExecution: {
              namespace: state.info.namespace,
              workflowId,
              runId,
            },
          },
        });
        state.completions.cancelWorkflow.set(seq, { resolve, reject });
      });
    },
    signal<Args extends any[]>(def: SignalDefinition<Args> | string, ...args: Args): Promise<void> {
      return composeInterceptors(
        state.interceptors.outbound,
        'signalWorkflow',
        signalWorkflowNextHandler
      )({
        seq: state.nextSeqs.signalWorkflow++,
        signalName: typeof def === 'string' ? def : def.name,
        args,
        target: {
          type: 'external',
          workflowExecution: { workflowId, runId },
        },
        headers: {},
      });
    },
  };
}

/**
 * Start a child Workflow execution
 *
 * - Returns a client-side handle that implements a child Workflow interface.
 * - By default, a child will be scheduled on the same task queue as its parent.
 *
 * A child Workflow handle supports awaiting completion, signaling and cancellation via {@link CancellationScope}s.
 * In order to query the child, use a {@link WorkflowClient} from an Activity.
 */
export async function startChild<T extends Workflow>(
  workflowType: string,
  options: WithWorkflowArgs<T, ChildWorkflowOptions>
): Promise<ChildWorkflowHandle<T>>;

/**
 * Start a child Workflow execution
 *
 * - Returns a client-side handle that implements a child Workflow interface.
 * - Deduces the Workflow type and signature from provided Workflow function.
 * - By default, a child will be scheduled on the same task queue as its parent.
 *
 * A child Workflow handle supports awaiting completion, signaling and cancellation via {@link CancellationScope}s.
 * In order to query the child, use a {@link WorkflowClient} from an Activity.
 */
export async function startChild<T extends Workflow>(
  workflowFunc: T,
  options: WithWorkflowArgs<T, ChildWorkflowOptions>
): Promise<ChildWorkflowHandle<T>>;

/**
 * Start a child Workflow execution
 *
 * **Override for Workflows that accept no arguments**.
 *
 * - Returns a client-side handle that implements a child Workflow interface.
 * - The child will be scheduled on the same task queue as its parent.
 *
 * A child Workflow handle supports awaiting completion, signaling and cancellation via {@link CancellationScope}s.
 * In order to query the child, use a {@link WorkflowClient} from an Activity.
 */
export async function startChild<T extends () => Promise<any>>(workflowType: string): Promise<ChildWorkflowHandle<T>>;

/**
 * Start a child Workflow execution
 *
 * **Override for Workflows that accept no arguments**.
 *
 * - Returns a client-side handle that implements a child Workflow interface.
 * - Deduces the Workflow type and signature from provided Workflow function.
 * - The child will be scheduled on the same task queue as its parent.
 *
 * A child Workflow handle supports awaiting completion, signaling and cancellation via {@link CancellationScope}s.
 * In order to query the child, use a {@link WorkflowClient} from an Activity.
 */
export async function startChild<T extends () => Promise<any>>(workflowFunc: T): Promise<ChildWorkflowHandle<T>>;

export async function startChild<T extends Workflow>(
  workflowTypeOrFunc: string | T,
  options?: WithWorkflowArgs<T, ChildWorkflowOptions>
): Promise<ChildWorkflowHandle<T>> {
  const optionsWithDefaults = addDefaultWorkflowOptions(options ?? {});
  const workflowType = typeof workflowTypeOrFunc === 'string' ? workflowTypeOrFunc : workflowTypeOrFunc.name;
  const execute = composeInterceptors(
    state.interceptors.outbound,
    'startChildWorkflowExecution',
    startChildWorkflowExecutionNextHandler
  );
  const [started, completed] = await execute({
    seq: state.nextSeqs.childWorkflow++,
    options: optionsWithDefaults,
    headers: {},
    workflowType,
  });
  const firstExecutionRunId = await started;

  return {
    workflowId: optionsWithDefaults.workflowId,
    firstExecutionRunId,
    async result(): Promise<WorkflowResultType<T>> {
      return (await completed) as any;
    },
    async signal<Args extends any[]>(def: SignalDefinition<Args> | string, ...args: Args): Promise<void> {
      return composeInterceptors(
        state.interceptors.outbound,
        'signalWorkflow',
        signalWorkflowNextHandler
      )({
        seq: state.nextSeqs.signalWorkflow++,
        signalName: typeof def === 'string' ? def : def.name,
        args,
        target: {
          type: 'child',
          childWorkflowId: optionsWithDefaults.workflowId,
        },
        headers: {},
      });
    },
  };
}

/**
 * Start a child Workflow execution and await its completion.
 *
 * - By default, a child will be scheduled on the same task queue as its parent.
 * - This operation is cancellable using {@link CancellationScope}s.
 *
 * @return The result of the child Workflow.
 */
export async function executeChild<T extends Workflow>(
  workflowType: string,
  options: WithWorkflowArgs<T, ChildWorkflowOptions>
): Promise<WorkflowResultType<T>>;

/**
 * Start a child Workflow execution and await its completion.
 *
 * - By default, a child will be scheduled on the same task queue as its parent.
 * - Deduces the Workflow type and signature from provided Workflow function.
 * - This operation is cancellable using {@link CancellationScope}s.
 *
 * @return The result of the child Workflow.
 */
export async function executeChild<T extends Workflow>(
  workflowType: T,
  options: WithWorkflowArgs<T, ChildWorkflowOptions>
): Promise<WorkflowResultType<T>>;

/**
 * Start a child Workflow execution and await its completion.
 *
 * **Override for Workflows that accept no arguments**.
 *
 * - The child will be scheduled on the same task queue as its parent.
 * - This operation is cancellable using {@link CancellationScope}s.
 *
 * @return The result of the child Workflow.
 */
export async function executeChild<T extends () => WorkflowReturnType>(
  workflowType: string
): Promise<WorkflowResultType<T>>;

/**
 * Start a child Workflow execution and await its completion.
 *
 * **Override for Workflows that accept no arguments**.
 *
 * - The child will be scheduled on the same task queue as its parent.
 * - Deduces the Workflow type and signature from provided Workflow function.
 * - This operation is cancellable using {@link CancellationScope}s.
 *
 * @return The result of the child Workflow.
 */
export async function executeChild<T extends () => WorkflowReturnType>(
  workflowFunc: T
): Promise<ChildWorkflowHandle<T>>;

export async function executeChild<T extends Workflow>(
  workflowTypeOrFunc: string | T,
  options?: WithWorkflowArgs<T, ChildWorkflowOptions>
): Promise<WorkflowResultType<T>> {
  const optionsWithDefaults = addDefaultWorkflowOptions(options ?? {});
  const workflowType = typeof workflowTypeOrFunc === 'string' ? workflowTypeOrFunc : workflowTypeOrFunc.name;
  const execute = composeInterceptors(
    state.interceptors.outbound,
    'startChildWorkflowExecution',
    startChildWorkflowExecutionNextHandler
  );
  const execPromise = execute({
    seq: state.nextSeqs.childWorkflow++,
    options: optionsWithDefaults,
    headers: {},
    workflowType,
  });
  untrackPromise(execPromise);
  const completedPromise = execPromise.then(([_started, completed]) => completed);
  untrackPromise(completedPromise);
  return completedPromise as Promise<any>;
}

/**
 * Get information about the current Workflow
 */
export function workflowInfo(): WorkflowInfo {
  if (state.info === undefined) {
    throw new IllegalStateError('Workflow uninitialized');
  }
  return state.info;
}

/**
 * Returns whether or not code is executing in workflow context
 */
export function inWorkflowContext(): boolean {
  try {
    workflowInfo();
    return true;
  } catch (err: any) {
    // Use string comparison in case multiple versions of @temporalio/common are
    // installed in which case an instanceof check would fail.
    if (err.name === 'IllegalStateError') {
      return false;
    } else {
      throw err;
    }
  }
}

/**
 * Get a reference to Sinks for exporting data out of the Workflow.
 *
 * These Sinks **must** be registered with the Worker in order for this
 * mechanism to work.
 *
 * @example
 * ```ts
 * import { proxySinks, Sinks } from '@temporalio/workflow';
 *
 * interface MySinks extends Sinks {
 *   logger: {
 *     info(message: string): void;
 *     error(message: string): void;
 *   };
 * }
 *
 * const { logger } = proxySinks<MyDependencies>();
 * logger.info('setting up');
 *
 * export function myWorkflow() {
 *   return {
 *     async execute() {
 *       logger.info('hey ho');
 *       logger.error('lets go');
 *     }
 *   };
 * }
 * ```
 */
export function proxySinks<T extends Sinks>(): T {
  return new Proxy(
    {},
    {
      get(_, ifaceName) {
        return new Proxy(
          {},
          {
            get(_, fnName) {
              return (...args: any[]) => {
                state.sinkCalls.push({
                  ifaceName: ifaceName as string,
                  fnName: fnName as string,
                  args,
                });
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
 * `f` takes the same arguments as the Workflow execute function supplied to typeparam `F`.
 *
 * Once `f` is called, Workflow execution immediately completes.
 */
export function makeContinueAsNewFunc<F extends Workflow>(
  options?: ContinueAsNewOptions
): (...args: Parameters<F>) => Promise<never> {
  const info = workflowInfo();
  const { workflowType, taskQueue, ...rest } = options ?? {};
  const requiredOptions = {
    workflowType: workflowType ?? info.workflowType,
    taskQueue: taskQueue ?? info.taskQueue,
    ...rest,
  };

  return (...args: Parameters<F>): Promise<never> => {
    const fn = composeInterceptors(state.interceptors.outbound, 'continueAsNew', async (input) => {
      const { headers, args, options } = input;
      throw new ContinueAsNew({
        workflowType: options.workflowType,
        arguments: toPayloads(state.payloadConverter, ...args),
        headers,
        taskQueue: options.taskQueue,
        memo: options.memo,
        searchAttributes: options.searchAttributes
          ? mapToPayloads(searchAttributePayloadConverter, options.searchAttributes)
          : undefined,
        workflowRunTimeout: msOptionalToTs(options.workflowRunTimeout),
        workflowTaskTimeout: msOptionalToTs(options.workflowTaskTimeout),
      });
    });
    return fn({
      args,
      headers: {},
      options: requiredOptions,
    });
  };
}

/**
 * Continues current Workflow execution as new with default options.
 *
 * Shorthand for `makeContinueAsNewFunc<F>()(...args)`.
 *
 * @example
 *
 * ```ts
 * import { continueAsNew } from '@temporalio/workflow';
 *
 * export function myWorkflow(n: number) {
 *   return {
 *     async execute() {
 *       // ... Workflow logic
 *       await continueAsNew<typeof myWorkflow>(n + 1);
 *     }
 *   };
 * }
 * ```
 */
export function continueAsNew<F extends Workflow>(...args: Parameters<F>): Promise<never> {
  return makeContinueAsNewFunc()(...args);
}

/**
 * Generate an RFC compliant V4 uuid.
 * Uses the workflow's deterministic PRNG making it safe for use within a workflow.
 * This function is cryptographically insecure.
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

/**
 * Patch or upgrade workflow code by checking or stating that this workflow has a certain patch.
 *
 * See [docs page](https://docs.temporal.io/typescript/versioning) for info.
 *
 * If the workflow is replaying an existing history, then this function returns true if that
 * history was produced by a worker which also had a `patched` call with the same `patchId`.
 * If the history was produced by a worker *without* such a call, then it will return false.
 *
 * If the workflow is not currently replaying, then this call *always* returns true.
 *
 * Your workflow code should run the "new" code if this returns true, if it returns false, you
 * should run the "old" code. By doing this, you can maintain determinism.
 *
 * @param patchId An identifier that should be unique to this patch. It is OK to use multiple
 * calls with the same ID, which means all such calls will always return the same value.
 */
export function patched(patchId: string): boolean {
  return patchInternal(patchId, false);
}

/**
 * Indicate that a patch is being phased out.
 *
 * See [docs page](https://docs.temporal.io/typescript/versioning) for info.
 *
 * Workflows with this call may be deployed alongside workflows with a {@link patched} call, but
 * they must *not* be deployed while any workers still exist running old code without a
 * {@link patched} call, or any runs with histories produced by such workers exist. If either kind
 * of worker encounters a history produced by the other, their behavior is undefined.
 *
 * Once all live workflow runs have been produced by workers with this call, you can deploy workers
 * which are free of either kind of patch call for this ID. Workers with and without this call
 * may coexist, as long as they are both running the "new" code.
 *
 * @param patchId An identifier that should be unique to this patch. It is OK to use multiple
 * calls with the same ID, which means all such calls will always return the same value.
 */
export function deprecatePatch(patchId: string): void {
  patchInternal(patchId, true);
}

function patchInternal(patchId: string, deprecated: boolean): boolean {
  // Patch operation does not support interception at the moment, if it did,
  // this would be the place to start the interception chain

  if (state.workflow === undefined) {
    throw new IllegalStateError('Patches cannot be used before Workflow starts');
  }
  const usePatch = !state.isReplaying || state.knownPresentPatches.has(patchId);
  // Avoid sending commands for patches core already knows about.
  // This optimization enables development of automatic patching tools.
  if (usePatch && !state.sentPatches.has(patchId)) {
    state.pushCommand({
      setPatchMarker: { patchId, deprecated },
    });
    state.sentPatches.add(patchId);
  }
  return usePatch;
}

/**
 * Returns a Promise that resolves when `fn` evaluates to `true` or `timeout` expires.
 *
 * @param timeout {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
 *
 * @returns a boolean indicating whether the condition was true before the timeout expires
 */
export function condition(fn: () => boolean, timeout: number | string): Promise<boolean>;

/**
 * Returns a Promise that resolves when `fn` evaluates to `true`.
 */
export function condition(fn: () => boolean): Promise<void>;

export async function condition(fn: () => boolean, timeout?: number | string): Promise<void | boolean> {
  if (timeout) {
    return CancellationScope.cancellable(async () => {
      try {
        return await Promise.race([sleep(timeout).then(() => false), conditionInner(fn).then(() => true)]);
      } finally {
        CancellationScope.current().cancel();
      }
    });
  }
  return conditionInner(fn);
}

function conditionInner(fn: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }

    const seq = state.nextSeqs.condition++;
    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch((err) => {
          state.blockedConditions.delete(seq);
          reject(err);
        })
      );
    }

    // Eager evaluation
    if (fn()) {
      resolve();
      return;
    }

    state.blockedConditions.set(seq, { fn, resolve });
  });
}

/**
 * Define a signal method for a Workflow.
 *
 * Definitions are used to register handler in the Workflow via {@link setHandler} and to signal Workflows using a {@link WorkflowHandle}, {@link ChildWorkflowHandle} or {@link ExternalWorkflowHandle}.
 * Definitions can be reused in multiple Workflows.
 */
export function defineSignal<Args extends any[] = []>(name: string): SignalDefinition<Args> {
  return {
    type: 'signal',
    name,
  };
}

/**
 * Define a query method for a Workflow.
 *
 * Definitions are used to register handler in the Workflow via {@link setHandler} and to query Workflows using a {@link WorkflowHandle}.
 * Definitions can be reused in multiple Workflows.
 */
export function defineQuery<Ret, Args extends any[] = []>(name: string): QueryDefinition<Ret, Args> {
  return {
    type: 'query',
    name,
  };
}

/**
 * A handler function capable of accepting the arguments for a given SignalDefinition or QueryDefinition.
 */
export type Handler<
  Ret,
  Args extends any[],
  T extends SignalDefinition<Args> | QueryDefinition<Ret, Args>
> = T extends SignalDefinition<infer A>
  ? (...args: A) => void | Promise<void>
  : T extends QueryDefinition<infer R, infer A>
  ? (...args: A) => R
  : never;

/**
 * Set a handler function for a Workflow query or signal.
 *
 * If this function is called multiple times for a given signal or query name the last handler will overwrite any previous calls.
 *
 * @param def a {@link SignalDefinition} or {@link QueryDefinition} as returned by {@link defineSignal} or {@link defineQuery} respectively.
 * @param handler a compatible handler function for the given definition or `undefined` to unset the handler.
 */
export function setHandler<Ret, Args extends any[], T extends SignalDefinition<Args> | QueryDefinition<Ret, Args>>(
  def: T,
  handler: Handler<Ret, Args, T> | undefined
): void {
  if (def.type === 'signal') {
    state.signalHandlers.set(def.name, handler as any);
    const bufferedSignals = state.bufferedSignals.get(def.name);
    if (bufferedSignals !== undefined && handler !== undefined) {
      state.bufferedSignals.delete(def.name);
      for (const signal of bufferedSignals) {
        state.activator.signalWorkflow(signal);
      }
    }
  } else if (def.type === 'query') {
    state.queryHandlers.set(def.name, handler as any);
  } else {
    throw new TypeError(`Invalid definition type: ${(def as any).type}`);
  }
}

/**
 * Updates this Workflow's Search Attributes by merging the provided `searchAttributes` with the existing Search
 * Attributes, `workflowInfo().searchAttributes`.
 *
 * For example, this Workflow code:
 *
 * ```ts
 * upsertSearchAttributes({
 *   CustomIntField: [1, 2, 3],
 *   CustomBoolField: [true]
 * });
 * upsertSearchAttributes({
 *   CustomIntField: [42],
 *   CustomKeywordField: ['durable code', 'is great']
 * });
 * ```
 *
 * would result in the Workflow having these Search Attributes:
 *
 * ```ts
 * {
 *   CustomIntField: [42],
 *   CustomBoolField: [true],
 *   CustomKeywordField: ['durable code', 'is great']
 * }
 * ```
 *
 * @param searchAttributes The Record to merge. Use a value of `[]` to clear a Search Attribute.
 */
export function upsertSearchAttributes(searchAttributes: SearchAttributes): void {
  if (!state.info) {
    throw new IllegalStateError('`state.info` should be defined');
  }

  const mergedSearchAttributes = { ...state.info.searchAttributes, ...searchAttributes };
  if (!mergedSearchAttributes) {
    throw new Error('searchAttributes must be a non-null SearchAttributes');
  }

  state.pushCommand({
    upsertWorkflowSearchAttributes: {
      searchAttributes: mapToPayloads(searchAttributePayloadConverter, searchAttributes),
    },
  });

  state.info.searchAttributes = mergedSearchAttributes;
}

/**
 * Unsafe information about the currently executing Workflow Task.
 *
 * Never rely on this information in Workflow logic as it will cause non-deterministic behavior.
 */
export interface UnsafeTaskInfo {
  isReplaying: boolean;
}

/**
 * Information about the currently executing Workflow Task.
 *
 * Meant for advanced usage.
 */
export interface TaskInfo {
  /**
   * Length of Workflow history up until the current Workflow Task.
   *
   * You may safely use this information to decide when to {@link continueAsNew}.
   */
  historyLength: number;
  unsafe: UnsafeTaskInfo;
}

/**
 * Get information about the currently executing Workflow Task.
 *
 * See {@link TaskInfo}
 */
export function taskInfo(): TaskInfo {
  const { isReplaying, historyLength } = state;
  if (isReplaying == null || historyLength == null) {
    throw new IllegalStateError('Workflow uninitialized');
  }

  return {
    historyLength,
    unsafe: {
      isReplaying,
    },
  };
}

export const stackTraceQuery = defineQuery<string>('__stack_trace');
