import { PayloadConverter } from '@temporalio/common';
import {
  arrayFromPayloads,
  defaultPayloadConverter,
  ensureTemporalFailure,
  errorToFailure,
  failureToError,
  optionalFailureToOptionalError,
  TemporalFailure,
} from '@temporalio/common';
import {
  checkExtends,
  composeInterceptors,
  IllegalStateError,
  Workflow,
  WorkflowQueryType,
  WorkflowSignalType,
} from '@temporalio/internal-workflow-common';
import type { coresdk } from '@temporalio/proto';
import { alea, RNG } from './alea';
import { ROOT_SCOPE } from './cancellation-scope';
import { DeterminismViolationError, isCancellation, WorkflowExecutionAlreadyStartedError } from './errors';
import {
  QueryInput,
  SignalInput,
  WorkflowExecuteInput,
  WorkflowInterceptors,
  WorkflowInterceptorsFactory,
} from './interceptors';
import { ContinueAsNew, WorkflowInfo } from './interfaces';
import { SinkCall } from './sinks';
import { untrackPromise } from './stack-helpers';

enum StartChildWorkflowExecutionFailedCause {
  START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_UNSPECIFIED = 0,
  START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_WORKFLOW_ALREADY_EXISTS = 1,
}

checkExtends<coresdk.child_workflow.StartChildWorkflowExecutionFailedCause, StartChildWorkflowExecutionFailedCause>();

/**
 * Global store to track promise stacks for stack trace query
 */
export interface PromiseStackStore {
  childToParent: Map<Promise<unknown>, Set<Promise<unknown>>>;
  promiseToStack: Map<Promise<unknown>, string>;
}

export type ResolveFunction<T = any> = (val: T) => any;
export type RejectFunction<E = any> = (val: E) => any;

export interface Completion {
  resolve: ResolveFunction;
  reject: RejectFunction;
}

export interface Condition {
  fn(): boolean;
  resolve(): void;
}

/**
 * A class that acts as a marker for this special result type
 */
export class LocalActivityDoBackoff {
  public readonly name = 'LocalActivityDoBackoff';
  constructor(public readonly backoff: coresdk.activity_result.IDoBackoff) {}
}

export type ActivationHandlerFunction<K extends keyof coresdk.workflow_activation.IWorkflowActivationJob> = (
  activation: NonNullable<coresdk.workflow_activation.IWorkflowActivationJob[K]>
) => void;

export type ActivationHandler = {
  [P in keyof coresdk.workflow_activation.IWorkflowActivationJob]: ActivationHandlerFunction<P>;
};

export class Activator implements ActivationHandler {
  workflowFunctionWasCalled = false;

  public async startWorkflowNextHandler({ args }: WorkflowExecuteInput): Promise<any> {
    const { workflow } = state;
    if (workflow === undefined) {
      throw new IllegalStateError('Workflow uninitialized');
    }
    let promise: Promise<any>;
    try {
      promise = workflow(...args);
    } finally {
      // Guarantee this runs even if there was an exception when invoking the Workflow function
      // Otherwise this Workflow will now be queryable.
      this.workflowFunctionWasCalled = true;
      // Empty the buffer
      const buffer = state.bufferedQueries.splice(0);
      for (const activation of buffer) {
        this.queryWorkflow(activation);
      }
    }
    return await promise;
  }

  public startWorkflow(activation: coresdk.workflow_activation.IStartWorkflow): void {
    const { info } = state;
    if (info === undefined) {
      throw new IllegalStateError('Workflow has not been initialized');
    }
    const execute = composeInterceptors(
      state.interceptors.inbound,
      'execute',
      this.startWorkflowNextHandler.bind(this)
    );
    untrackPromise(
      execute({
        headers: activation.headers ?? {},
        args: arrayFromPayloads(state.payloadConverter, activation.arguments),
      }).then(completeWorkflow, handleWorkflowFailure)
    );
  }

  public cancelWorkflow(_activation: coresdk.workflow_activation.ICancelWorkflow): void {
    state.cancelled = true;
    ROOT_SCOPE.cancel();
  }

  public fireTimer(activation: coresdk.workflow_activation.IFireTimer): void {
    // Timers are a special case where their completion might not be in Workflow state,
    // this is due to immediate timer cancellation that doesn't go wait for Core.
    const completion = maybeConsumeCompletion('timer', getSeq(activation));
    completion?.resolve(undefined);
  }

  public resolveActivity(activation: coresdk.workflow_activation.IResolveActivity): void {
    if (!activation.result) {
      throw new TypeError('Got ResolveActivity activation with no result');
    }
    const { resolve, reject } = consumeCompletion('activity', getSeq(activation));
    if (activation.result.completed) {
      const completed = activation.result.completed;
      const result = completed.result ? state.payloadConverter.fromPayload(completed.result) : undefined;
      resolve(result);
    } else if (activation.result.failed) {
      const { failure } = activation.result.failed;
      const err = optionalFailureToOptionalError(failure, state.payloadConverter);
      reject(err);
    } else if (activation.result.cancelled) {
      const { failure } = activation.result.cancelled;
      const err = optionalFailureToOptionalError(failure, state.payloadConverter);
      reject(err);
    } else if (activation.result.backoff) {
      reject(new LocalActivityDoBackoff(activation.result.backoff));
    }
  }

  public resolveChildWorkflowExecutionStart(
    activation: coresdk.workflow_activation.IResolveChildWorkflowExecutionStart
  ): void {
    const { resolve, reject } = consumeCompletion('childWorkflowStart', getSeq(activation));
    if (activation.succeeded) {
      resolve(activation.succeeded.runId);
    } else if (activation.failed) {
      if (
        activation.failed.cause !==
        StartChildWorkflowExecutionFailedCause.START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_WORKFLOW_ALREADY_EXISTS
      ) {
        throw new IllegalStateError('Got unknown StartChildWorkflowExecutionFailedCause');
      }
      if (!(activation.seq && activation.failed.workflowId && activation.failed.workflowType)) {
        throw new TypeError('Missing attributes in activation job');
      }
      reject(
        new WorkflowExecutionAlreadyStartedError(
          'Workflow execution already started',
          activation.failed.workflowId,
          activation.failed.workflowType
        )
      );
    } else if (activation.cancelled) {
      if (!activation.cancelled.failure) {
        throw new TypeError('Got no failure in cancelled variant');
      }
      reject(failureToError(activation.cancelled.failure, state.payloadConverter));
    } else {
      throw new TypeError('Got ResolveChildWorkflowExecutionStart with no status');
    }
  }

  public resolveChildWorkflowExecution(activation: coresdk.workflow_activation.IResolveChildWorkflowExecution): void {
    if (!activation.result) {
      throw new TypeError('Got ResolveChildWorkflowExecution activation with no result');
    }
    const { resolve, reject } = consumeCompletion('childWorkflowComplete', getSeq(activation));
    if (activation.result.completed) {
      const completed = activation.result.completed;
      const result = completed.result ? state.payloadConverter.fromPayload(completed.result) : undefined;
      resolve(result);
    } else if (activation.result.failed) {
      const { failure } = activation.result.failed;
      if (failure === undefined || failure === null) {
        throw new TypeError('Got failed result with no failure attribute');
      }
      reject(failureToError(failure, state.payloadConverter));
    } else if (activation.result.cancelled) {
      const { failure } = activation.result.cancelled;
      if (failure === undefined || failure === null) {
        throw new TypeError('Got cancelled result with no failure attribute');
      }
      reject(failureToError(failure, state.payloadConverter));
    }
  }

  // Intentionally not made function async so this handler doesn't show up in the stack trace
  protected queryWorkflowNextHandler({ queryName, args }: QueryInput): Promise<unknown> {
    const fn = state.queryHandlers.get(queryName);
    if (fn === undefined) {
      // Fail the query
      throw new ReferenceError(`Workflow did not register a handler for ${queryName}`);
    }
    try {
      const ret = fn(...args);
      if (ret instanceof Promise) {
        return Promise.reject(new DeterminismViolationError('Query handlers should not return a Promise'));
      }
      return Promise.resolve(ret);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  public queryWorkflow(activation: coresdk.workflow_activation.IQueryWorkflow): void {
    if (!this.workflowFunctionWasCalled) {
      state.bufferedQueries.push(activation);
      return;
    }

    const { queryType, queryId, headers } = activation;
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
      args: arrayFromPayloads(state.payloadConverter, activation.arguments),
      queryId,
      headers: headers ?? {},
    }).then(
      (result) => completeQuery(queryId, result),
      (reason) => failQuery(queryId, reason)
    );
  }

  public async signalWorkflowNextHandler({ signalName, args }: SignalInput): Promise<void> {
    const fn = state.signalHandlers.get(signalName);
    if (fn === undefined) {
      throw new IllegalStateError(`No registered signal handler for signal ${signalName}`);
    }
    return await fn(...args);
  }

  public signalWorkflow(activation: coresdk.workflow_activation.ISignalWorkflow): void {
    const { signalName, headers } = activation;
    if (!signalName) {
      throw new TypeError('Missing activation signalName');
    }

    const fn = state.signalHandlers.get(signalName);
    if (fn === undefined) {
      let buffer = state.bufferedSignals.get(signalName);
      if (buffer === undefined) {
        buffer = [];
        state.bufferedSignals.set(signalName, buffer);
      }
      buffer.push(activation);
      return;
    }

    const execute = composeInterceptors(
      state.interceptors.inbound,
      'handleSignal',
      this.signalWorkflowNextHandler.bind(this)
    );
    execute({
      args: arrayFromPayloads(state.payloadConverter, activation.input),
      signalName,
      headers: headers ?? {},
    }).catch(handleWorkflowFailure);
  }

  public resolveSignalExternalWorkflow(activation: coresdk.workflow_activation.IResolveSignalExternalWorkflow): void {
    const { resolve, reject } = consumeCompletion('signalWorkflow', getSeq(activation));
    if (activation.failure) {
      reject(failureToError(activation.failure, state.payloadConverter));
    } else {
      resolve(undefined);
    }
  }

  public resolveRequestCancelExternalWorkflow(
    activation: coresdk.workflow_activation.IResolveRequestCancelExternalWorkflow
  ): void {
    const { resolve, reject } = consumeCompletion('cancelWorkflow', getSeq(activation));
    if (activation.failure) {
      reject(failureToError(activation.failure, state.payloadConverter));
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

export type WorkflowsImportFunc = () => Promise<Record<string, any>>;
export type InterceptorsImportFunc = () => Promise<Array<{ interceptors: WorkflowInterceptorsFactory }>>;

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
    signalWorkflow: new Map<number, Completion>(),
    cancelWorkflow: new Map<number, Completion>(),
  };

  /**
   * Holds buffered signal calls until a handler is registered
   */
  public readonly bufferedSignals = new Map<string, coresdk.workflow_activation.ISignalWorkflow[]>();

  /**
   * Holds buffered query calls until a handler is registered.
   *
   * **IMPORTANT** queries are only buffered until workflow is started.
   * This is required because async interceptors might block workflow function invocation
   * which delays query handler registration.
   */
  public readonly bufferedQueries = Array<coresdk.workflow_activation.IQueryWorkflow>();

  /**
   * Mapping of signal name to handler
   */
  public readonly signalHandlers = new Map<string, WorkflowSignalType>();

  /**
   * Mapping of query name to handler
   */
  public readonly queryHandlers = new Map<string, WorkflowQueryType>([
    [
      '__stack_trace',
      () => {
        const { childToParent, promiseToStack } = (globalThis as any).__TEMPORAL__
          .promiseStackStore as PromiseStackStore;
        const internalNodes = new Set(
          [...childToParent.values()].reduce((acc, curr) => {
            for (const p of curr) {
              acc.add(p);
            }
            return acc;
          }, new Set())
        );
        const stacks = new Set<string>();
        for (const child of childToParent.keys()) {
          if (!internalNodes.has(child)) {
            const stack = promiseToStack.get(child);
            if (!stack) continue;
            stacks.add(stack);
          }
        }
        // Not 100% sure where this comes from, just filter it out
        stacks.delete('    at Promise.then (<anonymous>)');
        stacks.delete('    at Promise.then (<anonymous>)\n');
        return [...stacks].join('\n\n');
      },
    ],
  ]);

  /**
   * Loaded in {@link initRuntime}
   */
  public interceptors: Required<WorkflowInterceptors> = { inbound: [], outbound: [], internals: [] };

  /**
   * Buffer that stores all generated commands, reset after each activation
   */
  public commands: coresdk.workflow_commands.IWorkflowCommand[] = [];

  /**
   * Stores all {@link condition}s that haven't been unblocked yet
   */
  public blockedConditions = new Map<number, Condition>();

  /**
   * Is this Workflow completed?
   *
   * A Workflow will be considered completed if it generates a command that the
   * system considers as a final Workflow command (e.g.
   * completeWorkflowExecution or failWorkflowExecution).
   */
  public completed = false;

  /**
   * Was this Workflow cancelled?
   */
  public cancelled = false;

  /**
   * The next (incremental) sequence to assign when generating completable commands
   */
  public nextSeqs = {
    timer: 1,
    activity: 1,
    childWorkflow: 1,
    signalWorkflow: 1,
    cancelWorkflow: 1,
    condition: 1,
    // Used internally to keep track of active stack traces
    stack: 1,
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
   * Whether a Workflow is replaying history or processing new events
   */
  isReplaying?: boolean;

  /**
   * ID of last WorkflowTaskStarted event
   */
  historyLength?: number;

  /**
   * A deterministic RNG, used by the isolate's overridden Math.random
   */
  public random: RNG = function () {
    throw new IllegalStateError('Tried to use Math.random before Workflow has been initialized');
  };

  /**
   * Used to import the user workflows
   *
   * Injected on isolate context startup
   */
  public importWorkflows?: WorkflowsImportFunc;

  /**
   * Used to import the user interceptors
   *
   * Injected on isolate context startup
   */
  public importInterceptors?: InterceptorsImportFunc;

  public payloadConverter: PayloadConverter = defaultPayloadConverter;

  /**
   * Patches we know the status of for this workflow, as in {@link patched}
   */
  public readonly knownPresentPatches = new Set<string>();

  /**
   * Patches we sent to core {@link patched}
   */
  public readonly sentPatches = new Set<string>();

  sinkCalls = Array<SinkCall>();

  getAndResetSinkCalls(): SinkCall[] {
    const { sinkCalls } = this;
    this.sinkCalls = [];
    return sinkCalls;
  }

  /**
   * Buffer a Workflow command to be collected at the end of the current activation.
   *
   * Prevents commands from being added after Workflow completion.
   */
  pushCommand(cmd: coresdk.workflow_commands.IWorkflowCommand, complete = false): void {
    // Only query responses may be sent after completion
    if (this.completed && !cmd.respondToQuery) return;
    this.commands.push(cmd);
    if (complete) {
      this.completed = true;
    }
  }
}

export const state = new State();

function completeWorkflow(result: any) {
  state.pushCommand(
    {
      completeWorkflowExecution: {
        result: state.payloadConverter.toPayload(result),
      },
    },
    true
  );
}

/**
 * Transforms failures into a command to be sent to the server.
 * Used to handle any failure emitted by the Workflow.
 */
export async function handleWorkflowFailure(error: unknown): Promise<void> {
  if (state.cancelled && isCancellation(error)) {
    state.pushCommand({ cancelWorkflowExecution: {} }, true);
  } else if (error instanceof ContinueAsNew) {
    state.pushCommand({ continueAsNewWorkflowExecution: error.command }, true);
  } else {
    if (!(error instanceof TemporalFailure)) {
      // This results in an unhandled rejection which will fail the activation
      // preventing it from completing.
      throw error;
    }

    state.pushCommand(
      {
        failWorkflowExecution: {
          failure: errorToFailure(error, state.payloadConverter),
        },
      },
      true
    );
  }
}

function completeQuery(queryId: string, result: unknown) {
  state.pushCommand({
    respondToQuery: { queryId, succeeded: { response: state.payloadConverter.toPayload(result) } },
  });
}

async function failQuery(queryId: string, error: any) {
  state.pushCommand({
    respondToQuery: { queryId, failed: errorToFailure(ensureTemporalFailure(error), state.payloadConverter) },
  });
}

/** Consume a completion if it exists in Workflow state */
export function maybeConsumeCompletion(type: keyof State['completions'], taskSeq: number): Completion | undefined {
  const completion = state.completions[type].get(taskSeq);
  if (completion !== undefined) {
    state.completions[type].delete(taskSeq);
  }
  return completion;
}

/** Consume a completion if it exists in Workflow state, throws if it doesn't */
export function consumeCompletion(type: keyof State['completions'], taskSeq: number): Completion {
  const completion = maybeConsumeCompletion(type, taskSeq);
  if (completion === undefined) {
    throw new IllegalStateError(`No completion for taskSeq ${taskSeq}`);
  }
  return completion;
}

function getSeq<T extends { seq?: number | null }>(activation: T): number {
  const seq = activation.seq;
  if (seq === undefined || seq === null) {
    throw new TypeError(`Got activation with no seq attribute`);
  }
  return seq;
}
