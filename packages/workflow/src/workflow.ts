import {
  ActivityFunction,
  ActivityOptions,
  IllegalStateError,
  RemoteActivityOptions,
  msToTs,
  msOptionalToTs,
  Workflow,
  composeInterceptors,
  mapToPayloadsSync,
  WorkflowResultType,
} from '@temporalio/common';
import { coresdk } from '@temporalio/proto/lib/coresdk';
import {
  ChildWorkflowCancellationType,
  ChildWorkflowOptions,
  ChildWorkflowOptionsWithDefaults,
  ContinueAsNew,
  ContinueAsNewOptions,
  WorkflowInfo,
} from './interfaces';
import { state } from './internals';
import { WorkflowExecutionAlreadyStartedError } from './errors';
import { ActivityInput, StartChildWorkflowExecutionInput, SignalWorkflowInput, TimerInput } from './interceptors';
import { ExternalDependencies } from './dependencies';
import { CancellationScope, registerSleepImplementation } from './cancellation-scope';
import { ExternalWorkflowStub, ChildWorkflowStub } from './workflow-stub';

// Avoid a circular dependency
registerSleepImplementation(sleep);

/**
 * Adds default values to `workflowId` and `workflowIdReusePolicy` to given workflow options.
 */
export function addDefaultWorkflowOptions(opts: ChildWorkflowOptions): ChildWorkflowOptionsWithDefaults {
  return {
    taskQueue: Context.info.taskQueue,
    workflowId: uuid4(),
    workflowIdReusePolicy: coresdk.common.WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY,
    cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    ...opts,
  };
}

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
        if (!state.completions.timer.delete(input.seq)) {
          return; // Already resolved
        }
        state.commands.push({
          cancelTimer: {
            seq: input.seq,
          },
        });
        reject(err);
      });
    }
    state.completions.timer.set(input.seq, {
      resolve,
      reject,
    });
    state.commands.push({
      startTimer: {
        seq: input.seq,
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
  const seq = state.nextSeqs.timer++;

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
  return new Promise((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      scope.cancelRequested.catch(reject);
      return;
    }
    if (scope.cancellable) {
      scope.cancelRequested.catch(() => {
        if (!state.completions.activity.has(seq)) {
          return; // Already resolved
        }
        state.commands.push({
          requestCancelActivity: {
            seq,
          },
        });
      });
    }
    state.completions.activity.set(seq, {
      resolve,
      reject,
    });
    state.commands.push({
      scheduleActivity: {
        seq,
        activityId: options.activityId ?? `${seq}`,
        activityType,
        arguments: state.dataConverter.toPayloadsSync(...args),
        retryPolicy: options.retry
          ? {
              maximumAttempts: options.retry.maximumAttempts,
              initialInterval: msOptionalToTs(options.retry.initialInterval),
              maximumInterval: msOptionalToTs(options.retry.maximumInterval),
              backoffCoefficient: options.retry.backoffCoefficient,
              nonRetryableErrorTypes: options.retry.nonRetryableErrorTypes,
            }
          : undefined,
        taskQueue: options.taskQueue || state.info?.taskQueue,
        heartbeatTimeout: msOptionalToTs(options.heartbeatTimeout),
        scheduleToCloseTimeout: msOptionalToTs(options.scheduleToCloseTimeout),
        startToCloseTimeout: msOptionalToTs(options.startToCloseTimeout),
        scheduleToStartTimeout: msOptionalToTs(options.scheduleToStartTimeout),
        namespace: options.namespace,
        headerFields: Object.fromEntries(headers.entries()),
        cancellationType: options.cancellationType,
      },
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
    headers: new Map(),
    options,
    args,
    seq,
  }) as Promise<R>;
}

async function startChildWorkflowExecutionNextHandler({
  options,
  args,
  headers,
  workflowType,
  seq,
}: StartChildWorkflowExecutionInput): Promise<[Promise<string>, Promise<unknown>]> {
  const workflowId = options.workflowId ?? uuid4();
  const startPromise = new Promise<string>((resolve, reject) => {
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      scope.cancelRequested.catch(reject);
      return;
    }
    if (scope.cancellable) {
      scope.cancelRequested.catch(() => {
        const complete = !state.completions.childWorkflowComplete.has(seq);
        const started = !state.completions.childWorkflowStart.has(seq);

        if (started && !complete) {
          const cancelSeq = state.nextSeqs.cancelWorkflow++;
          state.commands.push({
            requestCancelExternalWorkflowExecution: {
              seq: cancelSeq,
              childWorkflowId: workflowId,
            },
          });
          // Not interested in this completion
          state.completions.cancelWorkflow.set(cancelSeq, { resolve: () => undefined, reject: () => undefined });
        } else if (!started) {
          state.commands.push({
            cancelUnstartedChildWorkflowExecution: { childWorkflowSeq: seq },
          });
        }
        // Nothing to cancel otherwise
      });
    }
    state.completions.childWorkflowStart.set(seq, {
      resolve,
      reject,
    });
    state.commands.push({
      startChildWorkflowExecution: {
        seq,
        workflowId,
        workflowType,
        input: state.dataConverter.toPayloadsSync(...args),
        retryPolicy: options.retryPolicy
          ? {
              maximumAttempts: options.retryPolicy.maximumAttempts,
              initialInterval: options.retryPolicy.initialInterval,
              maximumInterval: options.retryPolicy.maximumInterval,
              backoffCoefficient: options.retryPolicy.backoffCoefficient,
              nonRetryableErrorTypes: options.retryPolicy.nonRetryableErrorTypes,
            }
          : undefined,
        taskQueue: options.taskQueue || state.info?.taskQueue,
        workflowExecutionTimeout: msOptionalToTs(options.workflowExecutionTimeout),
        workflowRunTimeout: msOptionalToTs(options.workflowRunTimeout),
        workflowTaskTimeout: msOptionalToTs(options.workflowTaskTimeout),
        namespace: Context.info.namespace, // Not configurable
        header: Object.fromEntries(headers.entries()),
        cancellationType: options.cancellationType,
        workflowIdReusePolicy: options.workflowIdReusePolicy,
        parentClosePolicy: options.parentClosePolicy,
        cronSchedule: options.cronSchedule,
        searchAttributes: options.searchAttributes
          ? {
              indexedFields: mapToPayloadsSync(state.dataConverter, options.searchAttributes),
            }
          : undefined,
        memo: options.memo && mapToPayloadsSync(state.dataConverter, options.memo),
      },
    });
  });

  // We construct a Promise for the completion of the child Workflow before we know
  // if the Workflow code will await it to capture the result in case it does.
  const completePromise = new Promise((resolve, reject) => {
    // Chain start Promise rejection to the complete Promise.
    startPromise.catch(reject);
    state.completions.childWorkflowComplete.set(seq, {
      resolve,
      reject,
    });
  });
  // Prevent unhandled rejection because the completion might not be awaited
  completePromise.catch(() => undefined);
  return [startPromise, completePromise];
}

function signalWorkflowNextHandler({ seq, signalName, args, target }: SignalWorkflowInput) {
  return new Promise<any>((resolve, reject) => {
    if (state.info === undefined) {
      throw new IllegalStateError('Workflow uninitialized');
    }
    const scope = CancellationScope.current();
    if (scope.consideredCancelled) {
      scope.cancelRequested.catch(reject);
      return;
    }

    if (scope.cancellable) {
      scope.cancelRequested.catch(() => {
        if (!state.completions.signalWorkflow.has(seq)) {
          return;
        }
        state.commands.push({ cancelSignalWorkflow: { seq } });
      });
    }
    state.commands.push({
      signalExternalWorkflowExecution: {
        seq,
        args: state.dataConverter.toPayloadsSync(args),
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

export class ContextImpl {
  /**
   * @protected
   */
  constructor() {
    // Does nothing just marks this as protected for documentation
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
   * import { Context, ActivityInterface } from '@temporalio/workflow';
   * import * as activities from '../activities';
   *
   * // Setup Activities from module exports
   * const { httpGet, otherActivity } = Context.configureActivities<typeof activities>({
   *   type: 'remote',
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
   * } = Context.configureActivities<JavaActivities>({
   *   type: 'remote',
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
  public configureActivities<A extends Record<string, ActivityFunction<any, any>>>(options: ActivityOptions): A {
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
          return (...args: unknown[]) => {
            return scheduleActivity(activityType, args, options);
          };
        },
      }
    ) as any;
  }

  /**
   * Returns a client-side stub that can be used to signal and cancel an existing Workflow execution.
   * It takes a Workflow ID and optional run ID.
   */
  public external<T extends Workflow>(workflowId: string, runId?: string): ExternalWorkflowStub<T> {
    return {
      workflowId,
      runId,
      cancel() {
        return new Promise<void>((resolve, reject) => {
          if (state.info === undefined) {
            throw new IllegalStateError('Uninitialized workflow');
          }
          const seq = state.nextSeqs.cancelWorkflow++;
          state.commands.push({
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
      signal: new Proxy(
        {},
        {
          get(_, signalName) {
            if (typeof signalName !== 'string') {
              throw new TypeError(`Invalid signal type, expected string got: ${typeof signalName}`);
            }

            return (...args: any[]) => {
              return composeInterceptors(
                state.interceptors.outbound,
                'signalWorkflow',
                signalWorkflowNextHandler
              )({
                seq: state.nextSeqs.signalWorkflow++,
                signalName,
                args,
                target: {
                  type: 'external',
                  workflowExecution: { workflowId, runId },
                },
              });
            };
          },
        }
      ) as any,
    };
  }

  child<T extends Workflow>(workflowType: string, options?: ChildWorkflowOptions): ChildWorkflowStub<T>;
  child<T extends Workflow>(workflowFunc: T, options?: ChildWorkflowOptions): ChildWorkflowStub<T>;

  /**
   * Returns a client-side stub that implements a child Workflow interface.
   * It takes a child Workflow type and optional child Workflow options as arguments.
   * Workflow options may be needed to override the timeouts and task queue if they differ from the parent Workflow.
   *
   * A child Workflow supports starting, awaiting completion, signaling and cancellation via {@link CancellationScope}s.
   * In order to query the child, use a WorkflowClient from an Activity.
   */
  child<T extends Workflow>(workflowTypeOrFunc: string | T, options?: ChildWorkflowOptions): ChildWorkflowStub<T> {
    const optionsWithDefaults = addDefaultWorkflowOptions(options ?? {});
    const workflowType = typeof workflowTypeOrFunc === 'string' ? workflowTypeOrFunc : workflowTypeOrFunc.name;
    let started: Promise<string> | undefined = undefined;
    let completed: Promise<unknown> | undefined = undefined;

    return {
      workflowId: optionsWithDefaults.workflowId,
      async start(...args: Parameters<T>): Promise<string> {
        if (started !== undefined) {
          throw new WorkflowExecutionAlreadyStartedError(
            'Workflow execution already started',
            optionsWithDefaults.workflowId,
            workflowType
          );
        }
        const execute = composeInterceptors(
          state.interceptors.outbound,
          'startChildWorkflowExecution',
          startChildWorkflowExecutionNextHandler
        );
        [started, completed] = await execute({
          seq: state.nextSeqs.childWorkflow++,
          options: optionsWithDefaults,
          args,
          headers: new Map(),
          workflowType,
        });
        return await started;
      },
      async execute(...args: Parameters<T>): // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      WorkflowResultType<T> {
        await this.start(...args);
        return this.result();
      },
      result(): WorkflowResultType<T> {
        if (completed === undefined) {
          throw new IllegalStateError('Child Workflow was not started');
        }
        return completed as any;
      },
      signal: new Proxy(
        {},
        {
          get(_, signalName) {
            if (typeof signalName !== 'string') {
              throw new TypeError(`Invalid signal type, expected string got: ${typeof signalName}`);
            }
            return async (...args: any[]) => {
              if (started === undefined) {
                throw new IllegalStateError('Workflow execution not started');
              }
              return composeInterceptors(
                state.interceptors.outbound,
                'signalWorkflow',
                signalWorkflowNextHandler
              )({
                seq: state.nextSeqs.signalWorkflow++,
                signalName,
                args,
                target: {
                  type: 'child',
                  childWorkflowId: optionsWithDefaults.workflowId,
                },
              });
            };
          },
        }
      ) as any,
    };
  }

  /**
   * Returns whether or not this workflow received a cancellation request.
   *
   * The workflow might still be running in case cancellation was handled.
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
   * export function execute(): void {
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
   * `f` takes the same arguments as the Workflow execute function supplied to typeparam `F`.
   *
   * Once `f` is called, Workflow execution immediately completes.
   */
  public makeContinueAsNewFunc<F extends Workflow>(
    options?: ContinueAsNewOptions
  ): (...args: Parameters<F>) => Promise<never> {
    const nonOptionalOptions = { workflowType: state.info?.workflowType, taskQueue: state.info?.taskQueue, ...options };

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
          workflowRunTimeout: msOptionalToTs(options.workflowRunTimeout),
          workflowTaskTimeout: msOptionalToTs(options.workflowTaskTimeout),
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
   * async function execute(n: number) {
   *   // ... Workflow logic
   *   await Context.continueAsNew<typeof execute>(n + 1);
   * }
   * ```
   */
  public continueAsNew<F extends Workflow>(...args: Parameters<F>): Promise<never> {
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

/**
 * Patch or upgrade workflow code by checking or stating that this workflow has a certain patch.
 *
 * See [docs page](https://docs.temporal.io/docs/node/versioning) for info.
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
 * See [docs page](https://docs.temporal.io/docs/node/versioning) for info.
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
  if (state.info === undefined) {
    throw new IllegalStateError('Workflow info must be set when calling patch functions');
  }
  // Patch operation does not support interception at the moment, if it did,
  // this would be the place to start the interception chain

  const { isReplaying } = state.info;
  const usePatch = !isReplaying || state.knownPresentPatches.has(patchId);
  // Avoid sending commands for patches core already knows about.
  // This optimization enables development of automatic patching tools.
  if (usePatch && !state.sentPatches.has(patchId)) {
    state.commands.push({
      setPatchMarker: { patchId, deprecated },
    });
    state.sentPatches.add(patchId);
  }
  return usePatch;
}
