import {
  ActivityFunction,
  ActivityOptions,
  compileRetryPolicy,
  compilePriority,
  encodeActivityCancellationType,
  encodeWorkflowIdReusePolicy,
  extractWorkflowType,
  HandlerUnfinishedPolicy,
  LocalActivityOptions,
  mapToPayloads,
  QueryDefinition,
  SearchAttributes,
  SearchAttributeValue,
  SignalDefinition,
  toPayloads,
  TypedSearchAttributes,
  UntypedActivities,
  UpdateDefinition,
  WithWorkflowArgs,
  Workflow,
  WorkflowResultType,
  WorkflowReturnType,
  WorkflowUpdateValidatorType,
  SearchAttributeUpdatePair,
  WorkflowDefinitionOptionsOrGetter,
} from '@temporalio/common';
import { userMetadataToPayload } from '@temporalio/common/lib/user-metadata';
import {
  encodeUnifiedSearchAttributes,
  searchAttributePayloadConverter,
} from '@temporalio/common/lib/converter/payload-search-attributes';
import { versioningIntentToProto } from '@temporalio/common/lib/versioning-intent-enum';
import { Duration, msOptionalToTs, msToNumber, msToTs, requiredTsToMs } from '@temporalio/common/lib/time';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { temporal } from '@temporalio/proto';
import { deepMerge } from '@temporalio/common/lib/internal-workflow';
import { throwIfReservedName } from '@temporalio/common/lib/reserved';
import { CancellationScope, registerSleepImplementation } from './cancellation-scope';
import { UpdateScope } from './update-scope';
import {
  ActivityInput,
  LocalActivityInput,
  SignalWorkflowInput,
  StartChildWorkflowExecutionInput,
  TimerInput,
  TimerOptions,
} from './interceptors';
import {
  ChildWorkflowCancellationType,
  ChildWorkflowOptions,
  ChildWorkflowOptionsWithDefaults,
  ContinueAsNew,
  ContinueAsNewOptions,
  DefaultSignalHandler,
  EnhancedStackTrace,
  Handler,
  QueryHandlerOptions,
  SignalHandlerOptions,
  UpdateHandlerOptions,
  WorkflowInfo,
  UpdateInfo,
  encodeChildWorkflowCancellationType,
  encodeParentClosePolicy,
  DefaultUpdateHandler,
  DefaultQueryHandler,
} from './interfaces';
import { LocalActivityDoBackoff } from './errors';
import { assertInWorkflowContext, getActivator, maybeGetActivator } from './global-attributes';
import { untrackPromise } from './stack-helpers';
import { ChildWorkflowHandle, ExternalWorkflowHandle } from './workflow-handle';

// Avoid a circular dependency
registerSleepImplementation(sleep);

/**
 * Adds default values of `workflowId` and `cancellationType` to given workflow options.
 */
export function addDefaultWorkflowOptions<T extends Workflow>(
  opts: WithWorkflowArgs<T, ChildWorkflowOptions>
): ChildWorkflowOptionsWithDefaults {
  const { args, workflowId, ...rest } = opts;
  return {
    workflowId: workflowId ?? uuid4(),
    args: (args ?? []) as unknown[],
    cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    ...rest,
  };
}

/**
 * Push a startTimer command into state accumulator and register completion
 */
function timerNextHandler({ seq, durationMs, options }: TimerInput) {
  const activator = getActivator();
  return new Promise<void>((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }
    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch((err) => {
          if (!activator.completions.timer.delete(seq)) {
            return; // Already resolved or never scheduled
          }
          activator.pushCommand({
            cancelTimer: {
              seq,
            },
          });
          reject(err);
        })
      );
    }
    activator.pushCommand({
      startTimer: {
        seq,
        startToFireTimeout: msToTs(durationMs),
      },
      userMetadata: userMetadataToPayload(activator.payloadConverter, options?.summary, undefined),
    });
    activator.completions.timer.set(seq, {
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
 * @param ms sleep duration - number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}.
 * If given a negative number or 0, value will be set to 1.
 * @param options optional timer options for additional configuration
 */
export function sleep(ms: Duration, options?: TimerOptions): Promise<void> {
  const activator = assertInWorkflowContext('Workflow.sleep(...) may only be used from a Workflow Execution');
  const seq = activator.nextSeqs.timer++;

  const durationMs = Math.max(1, msToNumber(ms));

  const execute = composeInterceptors(activator.interceptors.outbound, 'startTimer', timerNextHandler);

  return execute({
    durationMs,
    seq,
    options,
  });
}

function validateActivityOptions(options: ActivityOptions): void {
  if (options.scheduleToCloseTimeout === undefined && options.startToCloseTimeout === undefined) {
    throw new TypeError('Required either scheduleToCloseTimeout or startToCloseTimeout');
  }
}

// Use same validation we use for normal activities
const validateLocalActivityOptions = validateActivityOptions;

/**
 * Push a scheduleActivity command into activator accumulator and register completion
 */
function scheduleActivityNextHandler({ options, args, headers, seq, activityType }: ActivityInput): Promise<unknown> {
  const activator = getActivator();
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
          if (!activator.completions.activity.has(seq)) {
            return; // Already resolved or never scheduled
          }
          activator.pushCommand({
            requestCancelActivity: {
              seq,
            },
          });
        })
      );
    }
    activator.pushCommand({
      scheduleActivity: {
        seq,
        activityId: options.activityId ?? `${seq}`,
        activityType,
        arguments: toPayloads(activator.payloadConverter, ...args),
        retryPolicy: options.retry ? compileRetryPolicy(options.retry) : undefined,
        taskQueue: options.taskQueue || activator.info.taskQueue,
        heartbeatTimeout: msOptionalToTs(options.heartbeatTimeout),
        scheduleToCloseTimeout: msOptionalToTs(options.scheduleToCloseTimeout),
        startToCloseTimeout: msOptionalToTs(options.startToCloseTimeout),
        scheduleToStartTimeout: msOptionalToTs(options.scheduleToStartTimeout),
        headers,
        cancellationType: encodeActivityCancellationType(options.cancellationType),
        doNotEagerlyExecute: !(options.allowEagerDispatch ?? true),
        versioningIntent: versioningIntentToProto(options.versioningIntent), // eslint-disable-line deprecation/deprecation
        priority: options.priority ? compilePriority(options.priority) : undefined,
      },
      userMetadata: userMetadataToPayload(activator.payloadConverter, options.summary, undefined),
    });
    activator.completions.activity.set(seq, {
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
  const activator = getActivator();
  // Eagerly fail the local activity (which will in turn fail the workflow task.
  // Do not fail on replay where the local activities may not be registered on the replay worker.
  if (!activator.info.unsafe.isReplaying && !activator.registeredActivityNames.has(activityType)) {
    throw new ReferenceError(`Local activity of type '${activityType}' not registered on worker`);
  }
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
          if (!activator.completions.activity.has(seq)) {
            return; // Already resolved or never scheduled
          }
          activator.pushCommand({
            requestCancelLocalActivity: {
              seq,
            },
          });
        })
      );
    }
    activator.pushCommand({
      scheduleLocalActivity: {
        seq,
        attempt,
        originalScheduleTime,
        // Intentionally not exposing activityId as an option
        activityId: `${seq}`,
        activityType,
        arguments: toPayloads(activator.payloadConverter, ...args),
        retryPolicy: options.retry ? compileRetryPolicy(options.retry) : undefined,
        scheduleToCloseTimeout: msOptionalToTs(options.scheduleToCloseTimeout),
        startToCloseTimeout: msOptionalToTs(options.startToCloseTimeout),
        scheduleToStartTimeout: msOptionalToTs(options.scheduleToStartTimeout),
        localRetryThreshold: msOptionalToTs(options.localRetryThreshold),
        headers,
        cancellationType: encodeActivityCancellationType(options.cancellationType),
      },
      userMetadata: userMetadataToPayload(activator.payloadConverter, options.summary, undefined),
    });
    activator.completions.activity.set(seq, {
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
  const activator = assertInWorkflowContext(
    'Workflow.scheduleActivity(...) may only be used from a Workflow Execution'
  );
  if (options === undefined) {
    throw new TypeError('Got empty activity options');
  }
  const seq = activator.nextSeqs.activity++;
  const execute = composeInterceptors(activator.interceptors.outbound, 'scheduleActivity', scheduleActivityNextHandler);

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
  const activator = assertInWorkflowContext(
    'Workflow.scheduleLocalActivity(...) may only be used from a Workflow Execution'
  );
  if (options === undefined) {
    throw new TypeError('Got empty activity options');
  }

  let attempt = 1;
  let originalScheduleTime = undefined;

  for (;;) {
    const seq = activator.nextSeqs.activity++;
    const execute = composeInterceptors(
      activator.interceptors.outbound,
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
        await sleep(requiredTsToMs(err.backoff.backoffDuration, 'backoffDuration'));
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
  const activator = getActivator();
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
          const complete = !activator.completions.childWorkflowComplete.has(seq);

          if (!complete) {
            activator.pushCommand({
              cancelChildWorkflowExecution: { childWorkflowSeq: seq },
            });
          }
          // Nothing to cancel otherwise
        })
      );
    }
    activator.pushCommand({
      startChildWorkflowExecution: {
        seq,
        workflowId,
        workflowType,
        input: toPayloads(activator.payloadConverter, ...options.args),
        retryPolicy: options.retry ? compileRetryPolicy(options.retry) : undefined,
        taskQueue: options.taskQueue || activator.info.taskQueue,
        workflowExecutionTimeout: msOptionalToTs(options.workflowExecutionTimeout),
        workflowRunTimeout: msOptionalToTs(options.workflowRunTimeout),
        workflowTaskTimeout: msOptionalToTs(options.workflowTaskTimeout),
        namespace: activator.info.namespace, // Not configurable
        headers,
        cancellationType: encodeChildWorkflowCancellationType(options.cancellationType),
        workflowIdReusePolicy: encodeWorkflowIdReusePolicy(options.workflowIdReusePolicy),
        parentClosePolicy: encodeParentClosePolicy(options.parentClosePolicy),
        cronSchedule: options.cronSchedule,
        searchAttributes:
          options.searchAttributes || options.typedSearchAttributes // eslint-disable-line deprecation/deprecation
            ? encodeUnifiedSearchAttributes(options.searchAttributes, options.typedSearchAttributes) // eslint-disable-line deprecation/deprecation
            : undefined,
        memo: options.memo && mapToPayloads(activator.payloadConverter, options.memo),
        versioningIntent: versioningIntentToProto(options.versioningIntent), // eslint-disable-line deprecation/deprecation
        priority: options.priority ? compilePriority(options.priority) : undefined,
      },
      userMetadata: userMetadataToPayload(activator.payloadConverter, options?.staticSummary, options?.staticDetails),
    });
    activator.completions.childWorkflowStart.set(seq, {
      resolve,
      reject,
    });
  });

  // We construct a Promise for the completion of the child Workflow before we know
  // if the Workflow code will await it to capture the result in case it does.
  const completePromise = new Promise((resolve, reject) => {
    // Chain start Promise rejection to the complete Promise.
    untrackPromise(startPromise.catch(reject));
    activator.completions.childWorkflowComplete.set(seq, {
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
  const activator = getActivator();
  return new Promise<any>((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }

    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch(() => {
          if (!activator.completions.signalWorkflow.has(seq)) {
            return;
          }
          activator.pushCommand({ cancelSignalWorkflow: { seq } });
        })
      );
    }
    activator.pushCommand({
      signalExternalWorkflowExecution: {
        seq,
        args: toPayloads(activator.payloadConverter, ...args),
        headers,
        signalName,
        ...(target.type === 'external'
          ? {
              workflowExecution: {
                namespace: activator.info.namespace,
                ...target.workflowExecution,
              },
            }
          : {
              childWorkflowId: target.childWorkflowId,
            }),
      },
    });

    activator.completions.signalWorkflow.set(seq, { resolve, reject });
  });
}

/**
 * Symbol used in the return type of proxy methods to mark that an attribute on the source type is not a method.
 *
 * @see {@link ActivityInterfaceFor}
 * @see {@link proxyActivities}
 * @see {@link proxyLocalActivities}
 */
export const NotAnActivityMethod = Symbol.for('__TEMPORAL_NOT_AN_ACTIVITY_METHOD');

/**
 * Type helper that takes a type `T` and transforms attributes that are not {@link ActivityFunction} to
 * {@link NotAnActivityMethod}.
 *
 * @example
 *
 * Used by {@link proxyActivities} to get this compile-time error:
 *
 * ```ts
 * interface MyActivities {
 *   valid(input: number): Promise<number>;
 *   invalid(input: number): number;
 * }
 *
 * const act = proxyActivities<MyActivities>({ startToCloseTimeout: '5m' });
 *
 * await act.valid(true);
 * await act.invalid();
 * // ^ TS complains with:
 * // (property) invalidDefinition: typeof NotAnActivityMethod
 * // This expression is not callable.
 * // Type 'Symbol' has no call signatures.(2349)
 * ```
 */
export type ActivityInterfaceFor<T> = {
  [K in keyof T]: T[K] extends ActivityFunction ? ActivityFunctionWithOptions<T[K]> : typeof NotAnActivityMethod;
};

export type ActivityFunctionWithOptions<T extends ActivityFunction> = T & {
  /**
   * Execute the activity, overriding its existing options with the
   * provided options.
   *
   * @param options ActivityOptions
   * @param args: list of arguments
   * @returns return value of the activity
   *
   * @experimental executeWithOptions is a new method to provide call-site options and is subject to change
   */
  executeWithOptions(options: ActivityOptions, args: Parameters<T>): Promise<Awaited<ReturnType<T>>>;
};

/**
 * The local activity counterpart to {@link ActivityInterfaceFor}
 */
export type LocalActivityInterfaceFor<T> = {
  [K in keyof T]: T[K] extends ActivityFunction ? LocalActivityFunctionWithOptions<T[K]> : typeof NotAnActivityMethod;
};

export type LocalActivityFunctionWithOptions<T extends ActivityFunction> = T & {
  /**
   * Run the local activity, overriding its existing options with the
   * provided options.
   *
   * @param options LocalActivityOptions
   * @param args: list of arguments
   * @returns return value of the activity
   *
   * @experimental executeWithOptions is a new method to provide call-site options and is subject to change
   */
  executeWithOptions(options: LocalActivityOptions, args: Parameters<T>): Promise<Awaited<ReturnType<T>>>;
};

/**
 * Configure Activity functions with given {@link ActivityOptions}.
 *
 * This method may be called multiple times to setup Activities with different options.
 *
 * @return a {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy | Proxy} for
 *         which each attribute is a callable Activity function
 *
 * @example
 * ```ts
 * import { proxyActivities } from '@temporalio/workflow';
 * import * as activities from '../activities';
 *
 * // Setup Activities from module exports
 * const { httpGet, otherActivity } = proxyActivities<typeof activities>({
 *   startToCloseTimeout: '30 minutes',
 * });
 *
 * // Use activities with default options
 * const result1 = await httpGet('http://example.com');
 *
 * // Override options for specific activity calls
 * const result2 = await httpGet.executeWithOptions({
 *   staticSummary: 'Fetches data from external API',
 *   scheduleToCloseTimeout: '5m'
 * }, ['http://api.example.com']);
 *
 * const result3 = await otherActivity.executeWithOptions({
 *   staticSummary: 'Processes the fetched data',
 *   taskQueue: 'special-task-queue'
 * }, [data]);
 *
 * // Setup Activities from an explicit interface (e.g. when defined by another SDK)
 * interface JavaActivities {
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
 *   const response = await httpGet("http://example.com");
 *   // Or with custom options:
 *   const response2 = await httpGetFromJava.executeWithOptions({
 *     staticSummary: 'Java HTTP call with timeout override',
 *     startToCloseTimeout: '2m'
 *   }, ["http://fast-api.example.com"]);
 *   // ...
 * }
 * ```
 */
export function proxyActivities<A = UntypedActivities>(options: ActivityOptions): ActivityInterfaceFor<A> {
  if (options === undefined) {
    throw new TypeError('options must be defined');
  }
  // Validate as early as possible for immediate user feedback
  validateActivityOptions(options);

  return new Proxy({} as ActivityInterfaceFor<A>, {
    get(_, activityType) {
      if (typeof activityType !== 'string') {
        throw new TypeError(`Only strings are supported for Activity types, got: ${String(activityType)}`);
      }

      function activityProxyFunction(...args: unknown[]): Promise<unknown> {
        return scheduleActivity(activityType as string, args, options);
      }

      activityProxyFunction.executeWithOptions = function (
        overrideOptions: ActivityOptions,
        args: any[]
      ): Promise<unknown> {
        return scheduleActivity(activityType, args, deepMerge(options, overrideOptions));
      };

      return activityProxyFunction;
    },
  });
}

/**
 * Configure Local Activity functions with given {@link LocalActivityOptions}.
 *
 * This method may be called multiple times to setup Activities with different options.
 *
 * @return a {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy | Proxy}
 *         for which each attribute is a callable Activity function
 *
 * @see {@link proxyActivities} for examples
 */
export function proxyLocalActivities<A = UntypedActivities>(
  options: LocalActivityOptions
): LocalActivityInterfaceFor<A> {
  if (options === undefined) {
    throw new TypeError('options must be defined');
  }
  // Validate as early as possible for immediate user feedback
  validateLocalActivityOptions(options);

  return new Proxy({} as LocalActivityInterfaceFor<A>, {
    get(_, activityType) {
      if (typeof activityType !== 'string') {
        throw new TypeError(`Only strings are supported for Activity types, got: ${String(activityType)}`);
      }

      function localActivityProxyFunction(...args: unknown[]): Promise<unknown> {
        return scheduleLocalActivity(activityType as string, args, options);
      }

      localActivityProxyFunction.executeWithOptions = function (
        overrideOptions: LocalActivityOptions,
        args: any[]
      ): Promise<unknown> {
        return scheduleLocalActivity(activityType, args, deepMerge(options, overrideOptions));
      };

      return localActivityProxyFunction;
    },
  });
}

// TODO: deprecate this patch after "enough" time has passed
const EXTERNAL_WF_CANCEL_PATCH = '__temporal_internal_connect_external_handle_cancel_to_scope';
// The name of this patch comes from an attempt to build a generic internal patching mechanism.
// That effort has been abandoned in favor of a newer WorkflowTaskCompletedMetadata based mechanism.
const CONDITION_0_PATCH = '__sdk_internal_patch_number:1';

/**
 * Returns a client-side handle that can be used to signal and cancel an existing Workflow execution.
 * It takes a Workflow ID and optional run ID.
 */
export function getExternalWorkflowHandle(workflowId: string, runId?: string): ExternalWorkflowHandle {
  const activator = assertInWorkflowContext(
    'Workflow.getExternalWorkflowHandle(...) may only be used from a Workflow Execution. Consider using Client.workflow.getHandle(...) instead.)'
  );
  return {
    workflowId,
    runId,
    cancel() {
      return new Promise<void>((resolve, reject) => {
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

        const seq = activator.nextSeqs.cancelWorkflow++;
        activator.pushCommand({
          requestCancelExternalWorkflowExecution: {
            seq,
            workflowExecution: {
              namespace: activator.info.namespace,
              workflowId,
              runId,
            },
          },
        });
        activator.completions.cancelWorkflow.set(seq, { resolve, reject });
      });
    },
    signal<Args extends any[]>(def: SignalDefinition<Args> | string, ...args: Args): Promise<void> {
      return composeInterceptors(
        activator.interceptors.outbound,
        'signalWorkflow',
        signalWorkflowNextHandler
      )({
        seq: activator.nextSeqs.signalWorkflow++,
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
  const activator = assertInWorkflowContext(
    'Workflow.startChild(...) may only be used from a Workflow Execution. Consider using Client.workflow.start(...) instead.)'
  );
  const optionsWithDefaults = addDefaultWorkflowOptions(options ?? ({} as any));
  const workflowType = extractWorkflowType(workflowTypeOrFunc);
  const execute = composeInterceptors(
    activator.interceptors.outbound,
    'startChildWorkflowExecution',
    startChildWorkflowExecutionNextHandler
  );
  const [started, completed] = await execute({
    seq: activator.nextSeqs.childWorkflow++,
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
        activator.interceptors.outbound,
        'signalWorkflow',
        signalWorkflowNextHandler
      )({
        seq: activator.nextSeqs.signalWorkflow++,
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
  workflowFunc: T,
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
export async function executeChild<T extends () => WorkflowReturnType>(workflowFunc: T): Promise<WorkflowResultType<T>>;

export async function executeChild<T extends Workflow>(
  workflowTypeOrFunc: string | T,
  options?: WithWorkflowArgs<T, ChildWorkflowOptions>
): Promise<WorkflowResultType<T>> {
  const activator = assertInWorkflowContext(
    'Workflow.executeChild(...) may only be used from a Workflow Execution. Consider using Client.workflow.execute(...) instead.'
  );
  const optionsWithDefaults = addDefaultWorkflowOptions(options ?? ({} as any));
  const workflowType = extractWorkflowType(workflowTypeOrFunc);
  const execute = composeInterceptors(
    activator.interceptors.outbound,
    'startChildWorkflowExecution',
    startChildWorkflowExecutionNextHandler
  );
  const execPromise = execute({
    seq: activator.nextSeqs.childWorkflow++,
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
 * Get information about the current Workflow.
 *
 * WARNING: This function returns a frozen copy of WorkflowInfo, at the point where this method has been called.
 * Changes happening at later point in workflow execution will not be reflected in the returned object.
 *
 * For this reason, we recommend calling `workflowInfo()` on every access to {@link WorkflowInfo}'s fields,
 * rather than caching the `WorkflowInfo` object (or part of it) in a local variable. For example:
 *
 * ```ts
 * // GOOD
 * function myWorkflow() {
 *   doSomething(workflowInfo().searchAttributes)
 *   ...
 *   doSomethingElse(workflowInfo().searchAttributes)
 * }
 * ```
 *
 * vs
 *
 * ```ts
 * // BAD
 * function myWorkflow() {
 *   const attributes = workflowInfo().searchAttributes
 *   doSomething(attributes)
 *   ...
 *   doSomethingElse(attributes)
 * }
 * ```
 */
export function workflowInfo(): WorkflowInfo {
  const activator = assertInWorkflowContext('Workflow.workflowInfo(...) may only be used from a Workflow Execution.');
  return activator.info;
}

/**
 * Get information about the current update if any.
 *
 * @return Info for the current update handler the code calling this is executing
 * within if any.
 */
export function currentUpdateInfo(): UpdateInfo | undefined {
  assertInWorkflowContext('Workflow.currentUpdateInfo(...) may only be used from a Workflow Execution.');
  return UpdateScope.current();
}

/**
 * Returns whether or not code is executing in workflow context
 */
export function inWorkflowContext(): boolean {
  return maybeGetActivator() !== undefined;
}

/**
 * Returns a function `f` that will cause the current Workflow to ContinueAsNew when called.
 *
 * `f` takes the same arguments as the Workflow function supplied to typeparam `F`.
 *
 * Once `f` is called, Workflow Execution immediately completes.
 */
export function makeContinueAsNewFunc<F extends Workflow>(
  options?: ContinueAsNewOptions
): (...args: Parameters<F>) => Promise<never> {
  const activator = assertInWorkflowContext(
    'Workflow.continueAsNew(...) and Workflow.makeContinueAsNewFunc(...) may only be used from a Workflow Execution.'
  );
  const info = activator.info;
  const { workflowType, taskQueue, ...rest } = options ?? {};
  const requiredOptions = {
    workflowType: workflowType ?? info.workflowType,
    taskQueue: taskQueue ?? info.taskQueue,
    ...rest,
  };

  return (...args: Parameters<F>): Promise<never> => {
    const fn = composeInterceptors(activator.interceptors.outbound, 'continueAsNew', async (input) => {
      const { headers, args, options } = input;
      throw new ContinueAsNew({
        workflowType: options.workflowType,
        arguments: toPayloads(activator.payloadConverter, ...args),
        headers,
        taskQueue: options.taskQueue,
        memo: options.memo && mapToPayloads(activator.payloadConverter, options.memo),
        searchAttributes:
          options.searchAttributes || options.typedSearchAttributes // eslint-disable-line deprecation/deprecation
            ? encodeUnifiedSearchAttributes(options.searchAttributes, options.typedSearchAttributes) // eslint-disable-line deprecation/deprecation
            : undefined,
        workflowRunTimeout: msOptionalToTs(options.workflowRunTimeout),
        workflowTaskTimeout: msOptionalToTs(options.workflowTaskTimeout),
        versioningIntent: versioningIntentToProto(options.versioningIntent), // eslint-disable-line deprecation/deprecation
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
 * {@link https://docs.temporal.io/concepts/what-is-continue-as-new/ | Continues-As-New} the current Workflow Execution
 * with default options.
 *
 * Shorthand for `makeContinueAsNewFunc<F>()(...args)`. (See: {@link makeContinueAsNewFunc}.)
 *
 * @example
 *
 * ```ts
 * import { continueAsNew } from '@temporalio/workflow';
 * import { SearchAttributeType } from '@temporalio/common';
 *
 * export async function myWorkflow(n: number): Promise<void> {
 *   // ... Workflow logic
 *   await continueAsNew<typeof myWorkflow>(n + 1);
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
 * See {@link https://docs.temporal.io/typescript/versioning | docs page} for info.
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
  const activator = assertInWorkflowContext(
    'Workflow.patch(...) and Workflow.deprecatePatch may only be used from a Workflow Execution.'
  );
  return activator.patchInternal(patchId, false);
}

/**
 * Indicate that a patch is being phased out.
 *
 * See {@link https://docs.temporal.io/typescript/versioning | docs page} for info.
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
  const activator = assertInWorkflowContext(
    'Workflow.patch(...) and Workflow.deprecatePatch may only be used from a Workflow Execution.'
  );
  activator.patchInternal(patchId, true);
}

/**
 * Returns a Promise that resolves when `fn` evaluates to `true` or `timeout` expires, providing
 * options to configure the timer (i.e. provide metadata)
 *
 * @param timeout number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
 *
 * @returns a boolean indicating whether the condition was true before the timeout expires
 *
 * @experimental TimerOptions is a new addition and subject to change
 */
export function condition(fn: () => boolean, timeout: Duration, options: TimerOptions): Promise<boolean>;

/**
 * Returns a Promise that resolves when `fn` evaluates to `true` or `timeout` expires.
 *
 * @param timeout number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
 *
 * @returns a boolean indicating whether the condition was true before the timeout expires
 */
export function condition(fn: () => boolean, timeout: Duration): Promise<boolean>;

/**
 * Returns a Promise that resolves when `fn` evaluates to `true`.
 */
export function condition(fn: () => boolean): Promise<void>;

export async function condition(fn: () => boolean, timeout?: Duration, opts?: TimerOptions): Promise<void | boolean> {
  assertInWorkflowContext('Workflow.condition(...) may only be used from a Workflow Execution.');
  // Prior to 1.5.0, `condition(fn, 0)` was treated as equivalent to `condition(fn, undefined)`
  if (timeout === 0 && !patched(CONDITION_0_PATCH)) {
    return conditionInner(fn);
  }
  if (typeof timeout === 'number' || typeof timeout === 'string') {
    return CancellationScope.cancellable(async () => {
      try {
        return await Promise.race([sleep(timeout, opts).then(() => false), conditionInner(fn).then(() => true)]);
      } finally {
        CancellationScope.current().cancel();
      }
    });
  }
  return conditionInner(fn);
}

function conditionInner(fn: () => boolean): Promise<void> {
  const activator = getActivator();
  return new Promise((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      untrackPromise(scope.cancelRequested.catch(reject));
      return;
    }

    const seq = activator.nextSeqs.condition++;
    if (scope.cancellable) {
      untrackPromise(
        scope.cancelRequested.catch((err) => {
          activator.blockedConditions.delete(seq);
          reject(err);
        })
      );
    }

    // Eager evaluation
    if (fn()) {
      resolve();
      return;
    }

    activator.blockedConditions.set(seq, { fn, resolve });
  });
}

/**
 * Define an update method for a Workflow.
 *
 * A definition is used to register a handler in the Workflow via {@link setHandler} and to update a Workflow using a {@link WorkflowHandle}, {@link ChildWorkflowHandle} or {@link ExternalWorkflowHandle}.
 * A definition can be reused in multiple Workflows.
 */
export function defineUpdate<Ret, Args extends any[] = [], Name extends string = string>(
  name: Name
): UpdateDefinition<Ret, Args, Name> {
  return {
    type: 'update',
    name,
  } as UpdateDefinition<Ret, Args, Name>;
}

/**
 * Define a signal method for a Workflow.
 *
 * A definition is used to register a handler in the Workflow via {@link setHandler} and to signal a Workflow using a {@link WorkflowHandle}, {@link ChildWorkflowHandle} or {@link ExternalWorkflowHandle}.
 * A definition can be reused in multiple Workflows.
 */
export function defineSignal<Args extends any[] = [], Name extends string = string>(
  name: Name
): SignalDefinition<Args, Name> {
  return {
    type: 'signal',
    name,
  } as SignalDefinition<Args, Name>;
}

/**
 * Define a query method for a Workflow.
 *
 * A definition is used to register a handler in the Workflow via {@link setHandler} and to query a Workflow using a {@link WorkflowHandle}.
 * A definition can be reused in multiple Workflows.
 */
export function defineQuery<Ret, Args extends any[] = [], Name extends string = string>(
  name: Name
): QueryDefinition<Ret, Args, Name> {
  return {
    type: 'query',
    name,
  } as QueryDefinition<Ret, Args, Name>;
}

/**
 * Set a handler function for a Workflow update, signal, or query.
 *
 * If this function is called multiple times for a given update, signal, or query name the last handler will overwrite any previous calls.
 *
 * @param def an {@link UpdateDefinition}, {@link SignalDefinition}, or {@link QueryDefinition} as returned by {@link defineUpdate}, {@link defineSignal}, or {@link defineQuery} respectively.
 * @param handler a compatible handler function for the given definition or `undefined` to unset the handler.
 * @param options an optional `description` of the handler and an optional update `validator` function.
 */
export function setHandler<Ret, Args extends any[], T extends QueryDefinition<Ret, Args>>(
  def: T,
  handler: Handler<Ret, Args, T> | undefined,
  options?: QueryHandlerOptions
): void;
export function setHandler<Ret, Args extends any[], T extends SignalDefinition<Args>>(
  def: T,
  handler: Handler<Ret, Args, T> | undefined,
  options?: SignalHandlerOptions
): void;
export function setHandler<Ret, Args extends any[], T extends UpdateDefinition<Ret, Args>>(
  def: T,
  handler: Handler<Ret, Args, T> | undefined,
  options?: UpdateHandlerOptions<Args>
): void;

// For Updates and Signals we want to make a public guarantee something like the
// following:
//
//   "If a WFT contains a Signal/Update, and if a handler is available for that
//   Signal/Update, then the handler will be executed.""
//
// However, that statement is not well-defined, leaving several questions open:
//
// 1. What does it mean for a handler to be "available"? What happens if the
//    handler is not present initially but is set at some point during the
//    Workflow code that is executed in that WFT? What happens if the handler is
//    set and then deleted, or replaced with a different handler?
//
// 2. When is the handler executed? (When it first becomes available? At the end
//    of the activation?) What are the execution semantics of Workflow and
//    Signal/Update handler code given that they are concurrent? Can the user
//    rely on Signal/Update side effects being reflected in the Workflow return
//    value, or in the value passed to Continue-As-New? If the handler is an
//    async function / coroutine, how much of it is executed and when is the
//    rest executed?
//
// 3. What happens if the handler is not executed? (i.e. because it wasn't
//    available in the sense defined by (1))
//
// 4. In the case of Update, when is the validation function executed?
//
// The implementation for Typescript is as follows:
//
// 1. sdk-core sorts Signal and Update jobs (and Patches) ahead of all other
//    jobs. Thus if the handler is available at the start of the Activation then
//    the Signal/Update will be executed before Workflow code is executed. If it
//    is not, then the Signal/Update calls are pushed to a buffer.
//
// 2. On each call to setHandler for a given Signal/Update, we make a pass
//    through the buffer list. If a buffered job is associated with the just-set
//    handler, then the job is removed from the buffer and the initial
//    synchronous portion of the handler is invoked on that input (i.e.
//    preempting workflow code).
//
// Thus in the case of Typescript the questions above are answered as follows:
//
// 1. A handler is "available" if it is set at the start of the Activation or
//    becomes set at any point during the Activation. If the handler is not set
//    initially then it is executed as soon as it is set. Subsequent deletion or
//    replacement by a different handler has no impact because the jobs it was
//    handling have already been handled and are no longer in the buffer.
//
// 2. The handler is executed as soon as it becomes available. I.e. if the
//    handler is set at the start of the Activation then it is executed when
//    first attempting to process the Signal/Update job; alternatively, if it is
//    set by a setHandler call made by Workflow code, then it is executed as
//    part of that call (preempting Workflow code). Therefore, a user can rely
//    on Signal/Update side effects being reflected in e.g. the Workflow return
//    value, and in the value passed to Continue-As-New. Activation jobs are
//    processed in the order supplied by sdk-core, i.e. Signals, then Updates,
//    then other jobs. Within each group, the order sent by the server is
//    preserved. If the handler is async, it is executed up to its first yield
//    point.
//
// 3. Signal case: If a handler does not become available for a Signal job then
//    the job remains in the buffer. If a handler for the Signal becomes
//    available in a subsequent Activation (of the same or a subsequent WFT)
//    then the handler will be executed. If not, then the Signal will never be
//    responded to and this causes no error.
//
//    Update case: If a handler does not become available for an Update job then
//    the Update is rejected at the end of the Activation. Thus, if a user does
//    not want an Update to be rejected for this reason, then it is their
//    responsibility to ensure that their application and workflow code interact
//    such that a handler is available for the Update during any Activation
//    which might contain their Update job. (Note that the user often has
//    uncertainty about which WFT their Signal/Update will appear in. For
//    example, if they call startWorkflow() followed by startUpdate(), then they
//    will typically not know whether these will be delivered in one or two
//    WFTs. On the other hand there are situations where they would have reason
//    to believe they are in the same WFT, for example if they do not start
//    Worker polling until after they have verified that both requests have
//    succeeded.)
//
// 4. If an Update has a validation function then it is executed immediately
//    prior to the handler. (Note that the validation function is required to be
//    synchronous).
export function setHandler<
  Ret,
  Args extends any[],
  T extends UpdateDefinition<Ret, Args> | SignalDefinition<Args> | QueryDefinition<Ret, Args>,
>(
  def: T,
  handler: Handler<Ret, Args, T> | undefined,
  options?: QueryHandlerOptions | SignalHandlerOptions | UpdateHandlerOptions<Args>
): void {
  const activator = assertInWorkflowContext('Workflow.setHandler(...) may only be used from a Workflow Execution.');
  // Cannot register handler for reserved names
  throwIfReservedName(def.type, def.name);
  const description = options?.description;
  if (def.type === 'update') {
    if (typeof handler === 'function') {
      const updateOptions = options as UpdateHandlerOptions<Args> | undefined;

      const validator = updateOptions?.validator as WorkflowUpdateValidatorType | undefined;
      const unfinishedPolicy = updateOptions?.unfinishedPolicy ?? HandlerUnfinishedPolicy.WARN_AND_ABANDON;
      activator.updateHandlers.set(def.name, { handler, validator, description, unfinishedPolicy });
      activator.dispatchBufferedUpdates();
    } else if (handler == null) {
      activator.updateHandlers.delete(def.name);
    } else {
      throw new TypeError(`Expected handler to be either a function or 'undefined'. Got: '${typeof handler}'`);
    }
  } else if (def.type === 'signal') {
    if (typeof handler === 'function') {
      const signalOptions = options as SignalHandlerOptions | undefined;
      const unfinishedPolicy = signalOptions?.unfinishedPolicy ?? HandlerUnfinishedPolicy.WARN_AND_ABANDON;
      activator.signalHandlers.set(def.name, { handler: handler as any, description, unfinishedPolicy });
      activator.dispatchBufferedSignals();
    } else if (handler == null) {
      activator.signalHandlers.delete(def.name);
    } else {
      throw new TypeError(`Expected handler to be either a function or 'undefined'. Got: '${typeof handler}'`);
    }
  } else if (def.type === 'query') {
    if (typeof handler === 'function') {
      activator.queryHandlers.set(def.name, { handler: handler as any, description });
    } else if (handler == null) {
      activator.queryHandlers.delete(def.name);
    } else {
      throw new TypeError(`Expected handler to be either a function or 'undefined'. Got: '${typeof handler}'`);
    }
  } else {
    throw new TypeError(`Invalid definition type: ${(def as any).type}`);
  }
}

/**
 * Set a signal handler function that will handle signals calls for non-registered signal names.
 *
 * Signals are dispatched to the default signal handler in the order that they were accepted by the server.
 *
 * If this function is called multiple times for a given signal name the last handler will overwrite any previous calls.
 *
 * @param handler a function that will handle signals for non-registered signal names, or `undefined` to unset the handler.
 */
export function setDefaultSignalHandler(handler: DefaultSignalHandler | undefined): void {
  const activator = assertInWorkflowContext(
    'Workflow.setDefaultSignalHandler(...) may only be used from a Workflow Execution.'
  );
  if (typeof handler === 'function') {
    activator.defaultSignalHandler = handler;
    activator.dispatchBufferedSignals();
  } else if (handler == null) {
    activator.defaultSignalHandler = undefined;
  } else {
    throw new TypeError(`Expected handler to be either a function or 'undefined'. Got: '${typeof handler}'`);
  }
}

/**
 * Set a update handler function that will handle updates calls for non-registered update names.
 *
 * Updates are dispatched to the default update handler in the order that they were accepted by the server.
 *
 * If this function is called multiple times for a given update name the last handler will overwrite any previous calls.
 *
 * @param handler a function that will handle updates for non-registered update names, or `undefined` to unset the handler.
 */
export function setDefaultUpdateHandler(handler: DefaultUpdateHandler | undefined): void {
  const activator = assertInWorkflowContext(
    'Workflow.setDefaultUpdateHandler(...) may only be used from a Workflow Execution.'
  );
  if (typeof handler === 'function') {
    activator.defaultUpdateHandler = handler;
    activator.dispatchBufferedUpdates();
  } else if (handler == null) {
    activator.defaultUpdateHandler = undefined;
  } else {
    throw new TypeError(`Expected handler to be either a function or 'undefined'. Got: '${typeof handler}'`);
  }
}

/**
 * Set a query handler function that will handle query calls for non-registered query names.
 *
 * Queries are dispatched to the default query handler in the order that they were accepted by the server.
 *
 * If this function is called multiple times for a given query name the last handler will overwrite any previous calls.
 *
 * @param handler a function that will handle queries for non-registered query names, or `undefined` to unset the handler.
 */
export function setDefaultQueryHandler(handler: DefaultQueryHandler | undefined): void {
  const activator = assertInWorkflowContext(
    'Workflow.setDefaultQueryHandler(...) may only be used from a Workflow Execution.'
  );
  if (typeof handler === 'function' || handler === undefined) {
    activator.defaultQueryHandler = handler;
  } else {
    throw new TypeError(`Expected handler to be either a function or 'undefined'. Got: '${typeof handler}'`);
  }
}

/**
 * Updates this Workflow's Search Attributes by merging the provided `searchAttributes` with the existing Search
 * Attributes, `workflowInfo().searchAttributes`.
 *
 * Search attributes can be upserted using either SearchAttributes (deprecated) or SearchAttributeUpdatePair[] (preferred)
 *
 * Upserting a workflow's search attributes using SearchAttributeUpdatePair[]:
 *
 * ```ts
 * const intKey = defineSearchKey('CustomIntField', 'INT');
 * const boolKey = defineSearchKey('CustomBoolField', 'BOOL');
 * const keywordListKey = defineSearchKey('CustomKeywordField', 'KEYWORD_LIST');
 *
 * upsertSearchAttributes([
 *  defineSearchAttribute(intKey, 1),
 *  defineSearchAttribute(boolKey, true)
 * ]);
 * upsertSearchAttributes([
 *  defineSearchAttribute(intKey, 42),
 *  defineSearchAttribute(keywordListKey, ['durable code', 'is great'])
 * ]);
 * ```
 *
 * Would result in the Workflow having these Search Attributes:
 *
 * ```ts
 * {
 *   CustomIntField: [42],
 *   CustomBoolField: [true],
 *   CustomKeywordField: ['durable code', 'is great']
 * }
 * ```
 *
 * @param searchAttributes The Record to merge.
 * If using SearchAttributeUpdatePair[] (preferred), set a value to null to remove the search attribute.
 * If using SearchAttributes (deprecated), set a value to undefined or an empty list to remove the search attribute.
 */
// eslint-disable-next-line deprecation/deprecation
export function upsertSearchAttributes(searchAttributes: SearchAttributes | SearchAttributeUpdatePair[]): void {
  const activator = assertInWorkflowContext(
    'Workflow.upsertSearchAttributes(...) may only be used from a Workflow Execution.'
  );

  if (searchAttributes == null) {
    throw new Error('searchAttributes must be a non-null SearchAttributes');
  }

  if (Array.isArray(searchAttributes)) {
    // Typed search attributes
    activator.pushCommand({
      upsertWorkflowSearchAttributes: {
        searchAttributes: encodeUnifiedSearchAttributes(undefined, searchAttributes),
      },
    });

    activator.mutateWorkflowInfo((info: WorkflowInfo): WorkflowInfo => {
      // Create a copy of the current state.
      const newSearchAttributes: SearchAttributes = { ...info.searchAttributes }; // eslint-disable-line deprecation/deprecation
      for (const pair of searchAttributes) {
        if (pair.value == null) {
          // If the value is null, remove the search attribute.
          // We don't mutate the existing state (just the new map) so this is safe.
          delete newSearchAttributes[pair.key.name];
        } else {
          newSearchAttributes[pair.key.name] = Array.isArray(pair.value)
            ? pair.value
            : ([pair.value] as SearchAttributeValue); // eslint-disable-line deprecation/deprecation
        }
      }
      return {
        ...info,
        searchAttributes: newSearchAttributes,
        // Create an empty copy and apply existing and new updates. Keep in mind the order matters here (existing first, new second - to possibly overwrite existing).
        typedSearchAttributes: info.typedSearchAttributes.updateCopy([...searchAttributes]),
      };
    });
  } else {
    // Legacy search attributes
    activator.pushCommand({
      upsertWorkflowSearchAttributes: {
        searchAttributes: mapToPayloads(searchAttributePayloadConverter, searchAttributes),
      },
    });

    activator.mutateWorkflowInfo((info: WorkflowInfo): WorkflowInfo => {
      // Create a new copy of the current state.
      let typedSearchAttributes = info.typedSearchAttributes.updateCopy([]);
      const newSearchAttributes: SearchAttributes = { ...info.searchAttributes }; // eslint-disable-line deprecation/deprecation

      // Upsert legacy search attributes into typedSearchAttributes.
      for (const [k, v] of Object.entries(searchAttributes)) {
        if (v !== undefined && !Array.isArray(v)) {
          throw new Error(`Search attribute value must be an array or undefined, got ${v}`);
        }

        // The value is undefined or an empty list, this signifies deletion.
        // Remove from both untyped & typed search attributes.
        if (v == null || (Array.isArray(v) && v.length === 0)) {
          // We cannot discern a valid key typing from these values.
          // Instead, we do a "best effort" deletion from typed search attributes:
          // - check if a matching key name exists, if so, remove it.
          const matchingPair = typedSearchAttributes.getAll().find((pair) => pair.key.name === k);
          if (matchingPair) {
            typedSearchAttributes = typedSearchAttributes.updateCopy([
              { key: matchingPair.key, value: null } as SearchAttributeUpdatePair,
            ]);
          }
          delete newSearchAttributes[k];
          continue;
        }

        // Attempt to discern a valid key typing for the update.
        const typedKey = TypedSearchAttributes.getKeyFromUntyped(k, v);

        // Unable to discern a valid key typing (no valid type for defined value).
        // Skip applying this update (no-op).
        if (typedKey === undefined) {
          continue;
        }

        // TEXT type is inferred from a string value, but it could also be KEYWORD.
        // If a matching pair exists with KEYWORD type, use that instead.
        if (typedKey.type === 'TEXT') {
          const matchingPair = typedSearchAttributes.getAll().find((pair) => pair.key.name === typedKey.name);
          if (matchingPair) {
            typedKey.type = matchingPair.key.type;
          }
        }

        let newValue: unknown = v;
        // Unpack value if it is a single-element array.
        if (v.length === 1) {
          newValue = v[0];
          // Convert value back to Date.
          if (typedKey.type === 'DATETIME') {
            newValue = new Date(newValue as string);
          }
        }

        // We have a defined value with valid type. Apply the update.
        typedSearchAttributes = typedSearchAttributes.updateCopy([
          { key: typedKey, value: newValue } as SearchAttributeUpdatePair,
        ]);
        newSearchAttributes[k] = v;
      }
      return {
        ...info,
        searchAttributes: newSearchAttributes,
        typedSearchAttributes,
      };
    });
  }
}

/**
 * Updates this Workflow's Memos by merging the provided `memo` with existing
 * Memos (as returned by `workflowInfo().memo`).
 *
 * New memo is merged by replacing properties of the same name _at the first
 * level only_. Setting a property to value `undefined` or `null` clears that
 * key from the Memo.
 *
 * For example:
 *
 * ```ts
 * upsertMemo({
 *   key1: value,
 *   key3: { subkey1: value }
 *   key4: value,
 * });
 * upsertMemo({
 *   key2: value
 *   key3: { subkey2: value }
 *   key4: undefined,
 * });
 * ```
 *
 * would result in the Workflow having these Memo:
 *
 * ```ts
 * {
 *   key1: value,
 *   key2: value,
 *   key3: { subkey2: value }  // Note this object was completely replaced
 *   // Note that key4 was completely removed
 * }
 * ```
 *
 * @param memo The Record to merge.
 */
export function upsertMemo(memo: Record<string, unknown>): void {
  const activator = assertInWorkflowContext('Workflow.upsertMemo(...) may only be used from a Workflow Execution.');

  if (memo == null) {
    throw new Error('memo must be a non-null Record');
  }

  activator.pushCommand({
    modifyWorkflowProperties: {
      upsertedMemo: {
        fields: mapToPayloads(
          activator.payloadConverter,
          // Convert null to undefined
          Object.fromEntries(Object.entries(memo).map(([k, v]) => [k, v ?? undefined]))
        ),
      },
    },
  });

  activator.mutateWorkflowInfo((info: WorkflowInfo): WorkflowInfo => {
    return {
      ...info,
      memo: Object.fromEntries(
        Object.entries({
          ...info.memo,
          ...memo,
        }).filter(([_, v]) => v != null)
      ),
    };
  });
}

/**
 * Whether update and signal handlers have finished executing.
 *
 * Consider waiting on this condition before workflow return or continue-as-new, to prevent
 * interruption of in-progress handlers by workflow exit:
 *
 * ```ts
 * await workflow.condition(workflow.allHandlersFinished)
 * ```
 *
 * @returns true if there are no in-progress update or signal handler executions.
 */
export function allHandlersFinished(): boolean {
  const activator = assertInWorkflowContext('allHandlersFinished() may only be used from a Workflow Execution.');
  return activator.inProgressSignals.size === 0 && activator.inProgressUpdates.size === 0;
}

/**
 * Can be used to alter workflow functions with certain options specified at definition time.
 *
 * @example
 * For example:
 * ```ts
 * setWorkflowOptions({ versioningBehavior: 'PINNED' }, myWorkflow);
 * export async function myWorkflow(): Promise<string> {
 *   // Workflow code here
 *   return "hi";
 * }
 * ```
 *
 * @example
 * To annotate a default or dynamic workflow:
 * ```ts
 * export default async function (): Promise<string> {
 *   // Workflow code here
 *   return "hi";
 * }
 * setWorkflowOptions({ versioningBehavior: 'PINNED' }, module.exports.default);
 * ```
 *
 * @param options Options for the workflow defintion, or a function that returns options. If a
 * function is provided, it will be called once just before the workflow function is called for the
 * first time. It is safe to call {@link workflowInfo} inside such a function.
 * @param fn The workflow function.
 */
export function setWorkflowOptions<A extends any[], RT>(
  options: WorkflowDefinitionOptionsOrGetter,
  fn: (...args: A) => Promise<RT>
): void {
  Object.assign(fn, {
    workflowDefinitionOptions: options,
  });
}

export const stackTraceQuery = defineQuery<string>('__stack_trace');
export const enhancedStackTraceQuery = defineQuery<EnhancedStackTrace>('__enhanced_stack_trace');
export const workflowMetadataQuery = defineQuery<temporal.api.sdk.v1.IWorkflowMetadata>('__temporal_workflow_metadata');

export function getCurrentDetails(): string {
  const activator = assertInWorkflowContext('getCurrentDetails() may only be used from a Workflow Execution.');
  return activator.currentDetails;
}

export function setCurrentDetails(details: string): void {
  const activator = assertInWorkflowContext('getCurrentDetails() may only be used from a Workflow Execution.');
  activator.currentDetails = details;
}
