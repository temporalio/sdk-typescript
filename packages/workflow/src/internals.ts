import Long from 'long';
import * as protobufjs from 'protobufjs/minimal';
import {
  ApplicationFailure,
  composeInterceptors,
  errorToFailure,
  ensureTemporalFailure,
  failureToError,
  optionalFailureToOptionalError,
  IllegalStateError,
  Workflow,
  WorkflowSignalType,
  DataConverter,
  defaultDataConverter,
  arrayFromPayloadsSync,
} from '@temporalio/common';
import { coresdk } from '@temporalio/proto/lib/coresdk';
import { alea, RNG } from './alea';
import { ContinueAsNew, ExternalDependencies, WorkflowInfo } from './interfaces';
import { QueryInput, SignalInput, WorkflowInput, WorkflowInterceptors } from './interceptors';
import { DeterminismViolationError, WorkflowExecutionAlreadyStartedError, isCancellation } from './errors';
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
) => Promise<void> | void;

export type ActivationHandler = {
  [P in keyof coresdk.workflow_activation.IWFActivationJob]: ActivationHandlerFunction<P>;
};

export class Activator implements ActivationHandler {
  public async startWorkflowNextHandler(req: () => Record<string, unknown>, input: WorkflowInput): Promise<any> {
    let mod: Record<string, unknown>;
    try {
      mod = req();
    } catch (err) {
      const failure = ApplicationFailure.nonRetryable(err.message, 'ReferenceError');
      failure.stack = failure.stack?.split('\n')[0];
      throw failure;
    }
    state.workflow = (mod.workflow ?? mod) as Workflow;
    return await state.workflow.main(...input.args);
  }

  public startWorkflow(activation: coresdk.workflow_activation.IStartWorkflow): void {
    const { require: req, info } = state;
    if (req === undefined || info === undefined) {
      throw new IllegalStateError('Workflow has not been initialized');
    }
    for (const mod of state.interceptorModules) {
      const { interceptors } = req(mod) as { interceptors: WorkflowInterceptors };
      state.interceptors.inbound.push(...interceptors.inbound);
      state.interceptors.outbound.push(...interceptors.outbound);
    }

    const execute = composeInterceptors(
      state.interceptors.inbound,
      'execute',
      this.startWorkflowNextHandler.bind(this, req.bind(undefined, info.filename))
    );
    execute({
      headers: new Map(Object.entries(activation.headers ?? {})),
      args: arrayFromPayloadsSync(state.dataConverter, activation.arguments),
    })
      .then(completeWorkflow)
      .catch(handleWorkflowFailure);
  }

  public cancelWorkflow(_activation: coresdk.workflow_activation.ICancelWorkflow): void {
    state.cancelled = true;
    ROOT_SCOPE.cancel();
  }

  public fireTimer(activation: coresdk.workflow_activation.IFireTimer): void {
    const { resolve } = consumeCompletion('timer', getSeq(activation));
    resolve(undefined);
  }

  public async resolveActivity(activation: coresdk.workflow_activation.IResolveActivity): Promise<void> {
    if (!activation.result) {
      throw new TypeError('Got ResolveActivity activation with no result');
    }
    const { resolve, reject } = consumeCompletion('activity', getSeq(activation));
    if (activation.result.completed) {
      const completed = activation.result.completed;
      const result = completed.result ? state.dataConverter.fromPayloadSync(completed.result) : undefined;
      resolve(result);
    } else if (activation.result.failed) {
      const { failure } = activation.result.failed;
      const err = await optionalFailureToOptionalError(failure, state.dataConverter);
      reject(err);
    } else if (activation.result.cancelled) {
      const { failure } = activation.result.cancelled;
      const err = await optionalFailureToOptionalError(failure, state.dataConverter);
      reject(err);
    }
  }

  public async resolveChildWorkflowExecutionStart(
    activation: coresdk.workflow_activation.IResolveChildWorkflowExecutionStart
  ): Promise<void> {
    const { resolve, reject } = consumeCompletion('childWorkflowStart', getSeq(activation));
    if (activation.succeeded) {
      resolve(activation.succeeded.runId);
    } else if (activation.failed) {
      if (
        activation.failed.cause !==
        coresdk.child_workflow.StartChildWorkflowExecutionFailedCause
          .START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_WORKFLOW_ALREADY_EXISTS
      ) {
        throw new IllegalStateError('Got unknown StartChildWorkflowExecutionFailedCause');
      }
      if (!(activation.seq && activation.failed?.workflowType)) {
        throw new TypeError('Missing attributes in activation job');
      }
      reject(
        new WorkflowExecutionAlreadyStartedError(
          'Workflow execution already started',
          'TODO: activation.workflowId',
          activation.failed.workflowType
        )
      );
    } else if (activation.cancelled) {
      if (!activation.cancelled.failure) {
        throw new TypeError('Got no failure in cancelled variant');
      }
      reject(await failureToError(activation.cancelled.failure, state.dataConverter));
    } else {
      throw new TypeError('Got ResolveChildWorkflowExecutionStart with no status');
    }
  }

  public async resolveChildWorkflowExecution(
    activation: coresdk.workflow_activation.IResolveChildWorkflowExecution
  ): Promise<void> {
    if (!activation.result) {
      throw new TypeError('Got ResolveChildWorkflowExecution activation with no result');
    }
    const { resolve, reject } = consumeCompletion('childWorkflowComplete', getSeq(activation));
    if (activation.result.completed) {
      const completed = activation.result.completed;
      const result = completed.result ? await state.dataConverter.fromPayload(completed.result) : undefined;
      resolve(result);
    } else if (activation.result.failed) {
      const { failure } = activation.result.failed;
      if (failure === undefined || failure === null) {
        throw new TypeError('Got failed result with no failure attribute');
      }
      reject(await failureToError(failure, state.dataConverter));
    } else if (activation.result.cancelled) {
      const { failure } = activation.result.cancelled;
      if (failure === undefined || failure === null) {
        throw new TypeError('Got cancelled result with no failure attribute');
      }
      reject(await failureToError(failure, state.dataConverter));
    }
  }

  protected async queryWorkflowNextHandler(input: QueryInput): Promise<unknown> {
    const fn = state.workflow?.queries?.[input.queryName];
    if (fn === undefined) {
      // Fail the query
      throw new ReferenceError(`Workflow did not register a handler for ${input.queryName}`);
    }
    const ret = fn(...input.args);
    if (ret instanceof Promise) {
      throw new DeterminismViolationError('Query handlers should not return a Promise');
    }
    return ret;
  }

  public queryWorkflow(activation: coresdk.workflow_activation.IQueryWorkflow): void {
    const { queryType, queryId } = activation;
    if (!(queryType && queryId)) {
      throw new TypeError('Missing query activation attributes');
    }
    const execute = composeInterceptors(
      state.interceptors.inbound,
      'handleQuery',
      this.queryWorkflowNextHandler.bind(this)
    );
    execute({
      queryName: queryType,
      args: arrayFromPayloadsSync(state.dataConverter, activation.arguments),
      queryId,
    }).then(
      (result) => completeQuery(queryId, result),
      (reason) => failQuery(queryId, reason)
    );
  }

  public async signalWorkflowNextHandler(fn: WorkflowSignalType, input: SignalInput): Promise<void> {
    return fn(...input.args);
  }

  public signalWorkflow(activation: coresdk.workflow_activation.ISignalWorkflow): void {
    const { signalName } = activation;
    if (!signalName) {
      throw new TypeError('Missing activation signalName');
    }

    const fn = state.workflow?.signals?.[signalName];
    if (fn === undefined) {
      // Fail the activation
      throw new ReferenceError(`Workflow did not register a signal handler for ${signalName}`);
    }
    const execute = composeInterceptors(
      state.interceptors.inbound,
      'handleSignal',
      this.signalWorkflowNextHandler.bind(this, fn)
    );
    execute({
      args: arrayFromPayloadsSync(state.dataConverter, activation.input),
      signalName,
    }).catch(handleWorkflowFailure);
  }

  public async resolveSignalExternalWorkflow(
    activation: coresdk.workflow_activation.IResolveSignalExternalWorkflow
  ): Promise<void> {
    const { resolve, reject } = consumeCompletion('signalWorkflow', getSeq(activation));
    if (activation.failure) {
      reject(await failureToError(activation.failure, state.dataConverter));
    } else {
      resolve(undefined);
    }
  }

  public async resolveRequestCancelExternalWorkflow(
    activation: coresdk.workflow_activation.IResolveRequestCancelExternalWorkflow
  ): Promise<void> {
    const { resolve, reject } = consumeCompletion('cancelWorkflow', getSeq(activation));
    if (activation.failure) {
      reject(await failureToError(activation.failure, state.dataConverter));
    } else {
      resolve(undefined);
    }
  }

  public updateRandomSeed(activation: coresdk.workflow_activation.IUpdateRandomSeed): void {
    if (!activation.randomnessSeed) {
      throw new TypeError('Expected activation with randomnessSeed attribute');
    }
    state.random = alea(activation.randomnessSeed.toBytes());
  }

  public notifyHasPatch(activation: coresdk.workflow_activation.INotifyHasPatch): void {
    if (!activation.patchId) {
      throw new TypeError('Notify has patch missing patch name');
    }
    state.knownPresentPatches.add(activation.patchId);
  }

  public removeFromCache(): void {
    throw new IllegalStateError('removeFromCache activation job should not reach workflow');
  }
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
  public readonly completions = {
    timer: new Map<number, Completion>(),
    activity: new Map<number, Completion>(),
    childWorkflowStart: new Map<number, Completion>(),
    childWorkflowComplete: new Map<number, Completion>(),
    dependency: new Map<number, Completion>(),
    signalWorkflow: new Map<number, Completion>(),
    cancelWorkflow: new Map<number, Completion>(),
  };

  /**
   * Overridden on WF initialization
   */
  public interceptorModules: string[] = [];
  /**
   * Loaded from `interceptorModules`
   */
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
  public nextSeqs = {
    timer: 1,
    activity: 1,
    childWorkflow: 1,
    dependency: 1,
    signalWorkflow: 1,
    cancelWorkflow: 1,
  };

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

  /**
   * Used to require user code
   *
   * Injected on isolate startup
   */
  public require?: (filename: string) => Record<string, unknown>;

  public dataConverter: DataConverter = defaultDataConverter;

  /**
   * Patches we know the status of for this workflow, as in {@link patched}
   */
  public readonly knownPresentPatches = new Set<string>();

  /**
   * Patches we sent to core {@link patched}
   */
  public readonly sentPatches = new Set<string>();
}

export const state = new State();

function completeWorkflow(result: any) {
  state.commands.push({
    completeWorkflowExecution: {
      result: state.dataConverter.toPayloadSync(result),
    },
  });
  state.completed = true;
}

async function handleWorkflowFailure(error: any) {
  if (state.cancelled && isCancellation(error)) {
    state.commands.push({ cancelWorkflowExecution: {} });
  } else if (error instanceof ContinueAsNew) {
    state.commands.push({ continueAsNewWorkflowExecution: error.command });
  } else {
    state.commands.push({
      failWorkflowExecution: {
        failure: await errorToFailure(ensureTemporalFailure(error), state.dataConverter),
      },
    });
  }
  state.completed = true;
}

function completeQuery(queryId: string, result: unknown) {
  state.commands.push({
    respondToQuery: { queryId, succeeded: { response: state.dataConverter.toPayloadSync(result) } },
  });
}

async function failQuery(queryId: string, error: any) {
  state.commands.push({
    respondToQuery: { queryId, failed: await errorToFailure(ensureTemporalFailure(error), state.dataConverter) },
  });
}

export function consumeCompletion(type: keyof State['completions'], taskSeq: number): Completion {
  const completion = state.completions[type].get(taskSeq);
  if (completion === undefined) {
    throw new IllegalStateError(`No completion for taskSeq ${taskSeq}`);
  }
  state.completions[type].delete(taskSeq);
  return completion;
}

function getSeq<T extends { seq?: number | null }>(activation: T): number {
  const seq = activation.seq;
  if (seq === undefined || seq === null) {
    throw new TypeError(`Got activation with no seq attribute`);
  }
  return seq;
}
