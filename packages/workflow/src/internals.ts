import Long from 'long';
import ivm from 'isolated-vm';
import * as protobufjs from 'protobufjs/minimal';
import { coresdk } from '@temporalio/proto';
import { defaultDataConverter, arrayFromPayloads } from './converter/data-converter';
import { alea, RNG } from './alea';
import {
  ActivityOptions,
  ApplyMode,
  ExternalDependencyFunction,
  ExternalDependencies,
  Workflow,
  WorkflowInfo,
} from './interfaces';
import { composeInterceptors, WorkflowInterceptors } from './interceptors';
import { CancelledError, IllegalStateError } from './errors';
import { errorToUserCodeFailure } from './common';
import { tsToMs, nullToUndefined } from './time';
import { ROOT_SCOPE } from './cancellation-scope';

export type ResolveFunction<T = any> = (val: T) => any;
export type RejectFunction<E = any> = (val: E) => any;

export interface Completion {
  resolve: ResolveFunction;
  reject: RejectFunction;
}

protobufjs.util.Long = Long;
protobufjs.configure();

export type ActivationHandlerFunction<K extends keyof coresdk.workflow_activation.IWFActivationJob> = (
  activation: NonNullable<coresdk.workflow_activation.IWFActivationJob[K]>
) => void;

export type ActivationHandler = {
  [P in keyof coresdk.workflow_activation.IWFActivationJob]: ActivationHandlerFunction<P>;
};

export class Activator implements ActivationHandler {
  public startWorkflow(activation: coresdk.workflow_activation.IStartWorkflow): void {
    const execute = composeInterceptors(state.interceptors.inbound, 'execute', async (input) => {
      if (state.workflow === undefined) {
        throw new IllegalStateError('state.workflow is not defined');
      }
      return state.workflow.main(...input.args);
    });
    execute({
      headers: new Map(Object.entries(activation.headers ?? {})),
      // TODO: support custom converter
      args: arrayFromPayloads(defaultDataConverter, activation.arguments),
    })
      .then(completeWorkflow)
      .catch(failWorkflow);
  }

  public cancelWorkflow(_activation: coresdk.workflow_activation.ICancelWorkflow): void {
    state.cancelled = true;
    ROOT_SCOPE.cancel();
  }

  public fireTimer(activation: coresdk.workflow_activation.IFireTimer): void {
    const { resolve } = consumeCompletion(idToSeq(activation.timerId));
    resolve(undefined);
  }

  public resolveActivity(activation: coresdk.workflow_activation.IResolveActivity): void {
    if (!activation.result) {
      throw new Error('Got CompleteActivity activation with no result');
    }
    const { resolve, reject } = consumeCompletion(idToSeq(activation.activityId));
    if (activation.result.completed) {
      const completed = activation.result.completed;
      const result = completed.result ? defaultDataConverter.fromPayload(completed.result) : undefined;
      resolve(result);
    } else if (activation.result.failed) {
      reject(new Error(nullToUndefined(activation.result.failed.failure?.message)));
    } else if (activation.result.canceled) {
      reject(new CancelledError('Activity cancelled'));
    }
  }

  public queryWorkflow(activation: coresdk.workflow_activation.IQueryWorkflow): void {
    if (state.workflow === undefined) {
      throw new Error('state.workflow is not defined');
    }
    // TODO: support custom converter
    try {
      const { queries } = state.workflow;
      if (queries === undefined) {
        throw new Error('Workflow did not define any queries');
      }
      if (!activation.queryType) {
        throw new Error('Missing query type');
      }

      const fn = queries[activation.queryType];
      const retOrPromise = fn(...arrayFromPayloads(defaultDataConverter, activation.arguments));
      if (retOrPromise instanceof Promise) {
        retOrPromise.then(completeQuery).catch(failQuery);
      } else {
        completeQuery(retOrPromise);
      }
    } catch (err) {
      failQuery(err);
    }
  }

  public signalWorkflow(activation: coresdk.workflow_activation.ISignalWorkflow): void {
    if (state.workflow === undefined) {
      throw new Error('state.workflow is not defined');
    }
    const { signals } = state.workflow;
    if (signals === undefined) {
      throw new Error('Workflow did not define any signals');
    }

    if (!activation.signalName) {
      throw new Error('Missing activation signalName');
    }

    const fn = signals[activation.signalName];
    if (fn === undefined) {
      throw new Error(`Workflow did not register a signal named ${activation.signalName}`);
    }
    const execute = composeInterceptors(state.interceptors.inbound, 'handleSignal', async (input) => {
      if (state.workflow === undefined) {
        throw new IllegalStateError('state.workflow is not defined');
      }
      return fn(...input.args);
    });
    execute({
      // TODO: support custom converter
      args: arrayFromPayloads(defaultDataConverter, activation.input),
      signalName: activation.signalName,
    }).catch(failWorkflow);
  }

  public updateRandomSeed(activation: coresdk.workflow_activation.IUpdateRandomSeed): void {
    if (!activation.randomnessSeed) {
      throw new Error('Expected activation with randomnessSeed attribute');
    }
    state.random = alea(activation.randomnessSeed.toBytes());
  }

  public removeFromCache(): void {
    throw new IllegalStateError('removeFromCache activation job should not reach workflow');
  }
}

type ActivationJobResult = { pendingExternalCalls: ExternalCall[]; processed: boolean };

/**
 * Run a single activation job.
 * @param jobIndex index of job to process in the activation's job array.
 * @returns a boolean indicating whether the job was processed or ignored
 */
export function activate(encodedActivation: Uint8Array, jobIndex: number): ActivationJobResult {
  const activation = coresdk.workflow_activation.WFActivation.decodeDelimited(encodedActivation);
  // job's type is IWFActivationJob which doesn't have the `attributes` property.
  const job = activation.jobs[jobIndex] as coresdk.workflow_activation.WFActivationJob;
  state.now = tsToMs(activation.timestamp);
  if (state.info === undefined) {
    throw new IllegalStateError('Workflow has not been initialized');
  }
  state.info.isReplaying = activation.isReplaying ?? false;
  if (job.variant === undefined) {
    throw new TypeError('Expected job.variant to be defined');
  }
  const variant = job[job.variant];
  if (!variant) {
    throw new TypeError(`Expected job.${job.variant} to be set`);
  }
  // The only job that can be executed on a completed workflow is a query.
  // We might get other jobs after completion for instance when a single
  // activation contains multiple jobs and the first one completes the workflow.
  if (state.completed && job.variant !== 'queryWorkflow') {
    return { processed: false, pendingExternalCalls: state.getAndResetPendingExternalCalls() };
  }
  state.activator[job.variant](variant);
  return { processed: true, pendingExternalCalls: state.getAndResetPendingExternalCalls() };
}

export interface ExternalCall {
  ifaceName: string;
  fnName: string;
  args: any[];
  /** Optional in case applyMode is ASYNC_IGNORED */
  seq?: number;
}

/**
 * Keeps all of the Workflow runtime state like pending completions for activities and timers and the scope stack.
 *
 * State mutates each time the Workflow is activated.
 */
export class State {
  /**
   * Activator executes activation jobs
   */
  public readonly activator = new Activator();
  /**
   * Map of task sequence to a Completion
   */
  public readonly completions: Map<number, Completion> = new Map();

  public interceptors: WorkflowInterceptors = { inbound: [], outbound: [] };
  /**
   * Buffer that stores all generated commands, reset after each activation
   */
  public commands: coresdk.workflow_commands.IWorkflowCommand[] = [];
  /**
   * Buffer containing external dependency calls which have not yet been transferred out of the isolate
   */
  public pendingExternalCalls: ExternalCall[] = [];
  /**
   * Is this Workflow completed
   */
  public completed = false;
  /**
   * Was this Workflow cancelled
   */
  public cancelled = false;
  /**
   * The next (incremental) sequence to assign when generating completable commands
   */
  public nextSeq = 0;

  /**
   * This is set every time the workflow executes an activation
   */
  #now: number | undefined;

  get now(): number {
    if (this.#now === undefined) {
      throw new IllegalStateError('Tried to get Date before Workflow has been initialized');
    }
    return this.#now;
  }

  set now(value: number) {
    this.#now = value;
  }

  /**
   * Reference to the current Workflow, initialized when a Workflow is started
   */
  public workflow?: Workflow;

  /**
   * Information about the current Workflow
   */
  public info?: WorkflowInfo;
  /**
   * Default ActivityOptions to set in `Context.configure`
   */
  public activityDefaults?: ActivityOptions;
  /**
   * A deterministic RNG, used by the isolate's overridden Math.random
   */
  public random: RNG = function () {
    throw new IllegalStateError('Tried to use Math.random before Workflow has been initialized');
  };

  public dependencies: ExternalDependencies = {};

  public getAndResetPendingExternalCalls(): ExternalCall[] {
    if (this.pendingExternalCalls.length > 0) {
      const ret = this.pendingExternalCalls;
      this.pendingExternalCalls = [];
      return ret;
    }
    return [];
  }
}

export const state = new State();

function completeWorkflow(result: any) {
  state.commands.push({
    completeWorkflowExecution: {
      result: defaultDataConverter.toPayload(result),
    },
  });
  state.completed = true;
}

function failWorkflow(error: any) {
  state.commands.push({
    failWorkflowExecution: {
      failure: errorToUserCodeFailure(error),
    },
  });
  state.completed = true;
}

function completeQuery(result: any) {
  state.commands.push({
    respondToQuery: { succeeded: { response: defaultDataConverter.toPayload(result) } },
  });
}

function failQuery(error: any) {
  state.commands.push({
    respondToQuery: { failedWithMessage: error.message },
  });
}

function consumeCompletion(taskSeq: number) {
  const completion = state.completions.get(taskSeq);
  if (completion === undefined) {
    throw new Error(`No completion for taskSeq ${taskSeq}`);
  }
  state.completions.delete(taskSeq);
  return completion;
}

function idToSeq(id: string | undefined | null) {
  if (!id) {
    throw new Error('Got activation with no timerId');
  }
  return parseInt(id);
}

type ActivationConclusion =
  | { type: 'pending'; pendingExternalCalls: ExternalCall[] }
  | { type: 'complete'; encoded: Uint8Array };

/**
 * Conclude a single activation.
 * Should be called after processing all activation jobs and queued microtasks.
 *
 * Activation may be in either `complete` or `pending` state according to pending external dependency calls.
 * Activation failures are handled in the main NodeJS isolate.
 */
export function concludeActivation(): ActivationConclusion {
  const pendingExternalCalls = state.getAndResetPendingExternalCalls();
  if (pendingExternalCalls.length > 0) {
    return { type: 'pending', pendingExternalCalls };
  }
  const { commands, info } = state;
  const encoded = coresdk.workflow_completion.WFActivationCompletion.encodeDelimited({
    runId: info?.runId,
    successful: { commands },
  }).finish();
  state.commands = [];
  return { type: 'complete', encoded };
}

export function getAndResetPendingExternalCalls(): ExternalCall[] {
  return state.getAndResetPendingExternalCalls();
}

/**
 * Inject an external dependency function into the Workflow via global state.
 * The injected function is available via {@link Context.dependencies}.
 */
export function inject(
  ifaceName: string,
  fnName: string,
  dependency: ivm.Reference<ExternalDependencyFunction>,
  applyMode: ApplyMode,
  transferOptions: ivm.TransferOptionsBidirectional
): void {
  if (state.dependencies[ifaceName] === undefined) {
    state.dependencies[ifaceName] = {};
  }
  if (applyMode === ApplyMode.ASYNC) {
    state.dependencies[ifaceName][fnName] = (...args: any[]) =>
      new Promise((resolve, reject) => {
        const seq = state.nextSeq++;
        state.completions.set(seq, {
          resolve,
          reject,
        });
        state.pendingExternalCalls.push({ ifaceName, fnName, args, seq });
      });
  } else if (applyMode === ApplyMode.ASYNC_IGNORED) {
    state.dependencies[ifaceName][fnName] = (...args: any[]) =>
      state.pendingExternalCalls.push({ ifaceName, fnName, args });
  } else {
    state.dependencies[ifaceName][fnName] = (...args: any[]) => dependency[applyMode](undefined, args, transferOptions);
  }
}

export interface ExternalDependencyResult {
  seq: number;
  result: any;
  error: any;
}

/**
 * Resolve external dependency function calls with given results.
 */
export function resolveExternalDependencies(results: ExternalDependencyResult[]): void {
  for (const { seq, result, error } of results) {
    const completion = consumeCompletion(seq);
    if (error) {
      completion.reject(error);
    } else {
      completion.resolve(result);
    }
  }
}
