import type { RawSourceMap } from 'source-map';
import {
  defaultFailureConverter,
  FailureConverter,
  PayloadConverter,
  arrayFromPayloads,
  defaultPayloadConverter,
  ensureTemporalFailure,
  HandlerUnfinishedPolicy,
  IllegalStateError,
  TemporalFailure,
  Workflow,
  WorkflowExecutionAlreadyStartedError,
  WorkflowQueryAnnotatedType,
  WorkflowSignalAnnotatedType,
  WorkflowUpdateAnnotatedType,
  ProtoFailure,
  ApplicationFailure,
  WorkflowUpdateType,
  WorkflowUpdateValidatorType,
  mapFromPayloads,
  searchAttributePayloadConverter,
  fromPayloadsAtIndex,
  SearchAttributes,
} from '@temporalio/common';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { makeProtoEnumConverters } from '@temporalio/common/lib/internal-workflow';
import type { coresdk, temporal } from '@temporalio/proto';
import { alea, RNG } from './alea';
import { RootCancellationScope } from './cancellation-scope';
import { UpdateScope } from './update-scope';
import { DeterminismViolationError, LocalActivityDoBackoff, isCancellation } from './errors';
import { QueryInput, SignalInput, UpdateInput, WorkflowExecuteInput, WorkflowInterceptors } from './interceptors';
import {
  ContinueAsNew,
  DefaultSignalHandler,
  StackTraceSDKInfo,
  StackTraceFileSlice,
  EnhancedStackTrace,
  StackTraceFileLocation,
  WorkflowInfo,
  WorkflowCreateOptionsInternal,
  ActivationCompletion,
} from './interfaces';
import { type SinkCall } from './sinks';
import { untrackPromise } from './stack-helpers';
import pkg from './pkg';
import { SdkFlag, assertValidFlag } from './flags';
import { executeWithLifecycleLogging, log } from './logs';

const StartChildWorkflowExecutionFailedCause = {
  WORKFLOW_ALREADY_EXISTS: 'WORKFLOW_ALREADY_EXISTS',
} as const;
type StartChildWorkflowExecutionFailedCause =
  (typeof StartChildWorkflowExecutionFailedCause)[keyof typeof StartChildWorkflowExecutionFailedCause];

const [_encodeStartChildWorkflowExecutionFailedCause, decodeStartChildWorkflowExecutionFailedCause] =
  makeProtoEnumConverters<
    coresdk.child_workflow.StartChildWorkflowExecutionFailedCause,
    typeof coresdk.child_workflow.StartChildWorkflowExecutionFailedCause,
    keyof typeof coresdk.child_workflow.StartChildWorkflowExecutionFailedCause,
    typeof StartChildWorkflowExecutionFailedCause,
    'START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_'
  >(
    {
      [StartChildWorkflowExecutionFailedCause.WORKFLOW_ALREADY_EXISTS]: 1,
      UNSPECIFIED: 0,
    } as const,
    'START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_'
  );

export interface Stack {
  formatted: string;
  structured: StackTraceFileLocation[];
}

/**
 * Global store to track promise stacks for stack trace query
 */
export interface PromiseStackStore {
  childToParent: Map<Promise<unknown>, Set<Promise<unknown>>>;
  promiseToStack: Map<Promise<unknown>, Stack>;
}

export interface Completion {
  resolve(val: unknown): unknown;

  reject(reason: unknown): unknown;
}

export interface Condition {
  fn(): boolean;

  resolve(): void;
}

export type ActivationHandlerFunction<K extends keyof coresdk.workflow_activation.IWorkflowActivationJob> = (
  activation: NonNullable<coresdk.workflow_activation.IWorkflowActivationJob[K]>
) => void;

/**
 * Verifies all activation job handling methods are implemented
 */
export type ActivationHandler = {
  [P in keyof coresdk.workflow_activation.IWorkflowActivationJob]: ActivationHandlerFunction<P>;
};

/**
 * Information about an update or signal handler execution.
 */
interface MessageHandlerExecution {
  name: string;
  unfinishedPolicy: HandlerUnfinishedPolicy;
  id?: string;
}

/**
 * Keeps all of the Workflow runtime state like pending completions for activities and timers.
 *
 * Implements handlers for all workflow activation jobs.
 *
 * Note that most methods in this class are meant to be called only from within the VM.
 *
 * However, a few methods may be called directly from outside the VM (essentially from `vm-shared.ts`).
 * These methods are specifically marked with a comment and require careful consideration, as the
 * execution context may not properly reflect that of the target workflow execution (e.g.: with Reusable
 * VMs, the `global` may not have been swapped to those of that workflow execution; the active microtask
 * queue may be that of the thread/process, rather than the queue of that VM context; etc). Consequently,
 * methods that are meant to be called from outside of the VM must not do any of the following:
 *
 * - Access any global variable;
 * - Create Promise objects, use async/await, or otherwise schedule microtasks;
 * - Call user-defined functions, including any form of interceptor.
 */
export class Activator implements ActivationHandler {
  /**
   * Cache for modules - referenced in reusable-vm.ts
   */
  readonly moduleCache = new Map<string, unknown>();
  /**
   * Map of task sequence to a Completion
   */
  readonly completions = {
    timer: new Map<number, Completion>(),
    activity: new Map<number, Completion>(),
    childWorkflowStart: new Map<number, Completion>(),
    childWorkflowComplete: new Map<number, Completion>(),
    signalWorkflow: new Map<number, Completion>(),
    cancelWorkflow: new Map<number, Completion>(),
  };

  /**
   * Holds buffered Update calls until a handler is registered
   */
  readonly bufferedUpdates = Array<coresdk.workflow_activation.IDoUpdate>();

  /**
   * Holds buffered signal calls until a handler is registered
   */
  readonly bufferedSignals = Array<coresdk.workflow_activation.ISignalWorkflow>();

  /**
   * Mapping of update name to handler and validator
   */
  readonly updateHandlers = new Map<string, WorkflowUpdateAnnotatedType>();

  /**
   * Mapping of signal name to handler
   */
  readonly signalHandlers = new Map<string, WorkflowSignalAnnotatedType>();

  /**
   * Mapping of in-progress updates to handler execution information.
   */
  readonly inProgressUpdates = new Map<string, MessageHandlerExecution>();

  /**
   * Mapping of in-progress signals to handler execution information.
   */
  readonly inProgressSignals = new Map<number, MessageHandlerExecution>();

  /**
   * A sequence number providing unique identifiers for signal handler executions.
   */
  protected signalHandlerExecutionSeq = 0;

  /**
   * A signal handler that catches calls for non-registered signal names.
   */
  defaultSignalHandler?: DefaultSignalHandler;

  /**
   * Source map file for looking up the source files in response to __enhanced_stack_trace
   */
  protected readonly sourceMap: RawSourceMap;

  /**
   * Whether or not to send the sources in enhanced stack trace query responses
   */
  protected readonly showStackTraceSources;

  readonly promiseStackStore: PromiseStackStore = {
    promiseToStack: new Map(),
    childToParent: new Map(),
  };

  public readonly rootScope = new RootCancellationScope();

  /**
   * Mapping of query name to handler
   */
  public readonly queryHandlers = new Map<string, WorkflowQueryAnnotatedType>([
    [
      '__stack_trace',
      {
        handler: () => {
          return this.getStackTraces()
            .map((s) => s.formatted)
            .join('\n\n');
        },
        description: 'Returns a sensible stack trace.',
      },
    ],
    [
      '__enhanced_stack_trace',
      {
        handler: (): EnhancedStackTrace => {
          const { sourceMap } = this;
          const sdk: StackTraceSDKInfo = { name: 'typescript', version: pkg.version };
          const stacks = this.getStackTraces().map(({ structured: locations }) => ({ locations }));
          const sources: Record<string, StackTraceFileSlice[]> = {};
          if (this.showStackTraceSources) {
            for (const { locations } of stacks) {
              for (const { file_path } of locations) {
                if (!file_path) continue;
                const content = sourceMap?.sourcesContent?.[sourceMap?.sources.indexOf(file_path)];
                if (!content) continue;
                sources[file_path] = [
                  {
                    line_offset: 0,
                    content,
                  },
                ];
              }
            }
          }
          return { sdk, stacks, sources };
        },
        description: 'Returns a stack trace annotated with source information.',
      },
    ],
    [
      '__temporal_workflow_metadata',
      {
        handler: (): temporal.api.sdk.v1.IWorkflowMetadata => {
          const workflowType = this.info.workflowType;
          const queryDefinitions = Array.from(this.queryHandlers.entries()).map(([name, value]) => ({
            name,
            description: value.description,
          }));
          const signalDefinitions = Array.from(this.signalHandlers.entries()).map(([name, value]) => ({
            name,
            description: value.description,
          }));
          const updateDefinitions = Array.from(this.updateHandlers.entries()).map(([name, value]) => ({
            name,
            description: value.description,
          }));
          return {
            definition: {
              type: workflowType,
              queryDefinitions,
              signalDefinitions,
              updateDefinitions,
            },
          };
        },
        description: 'Returns metadata associated with this workflow.',
      },
    ],
  ]);

  /**
   * Loaded in {@link initRuntime}
   */
  public readonly interceptors: Required<WorkflowInterceptors> = {
    inbound: [],
    outbound: [],
    internals: [],
  };

  /**
   * Buffer that stores all generated commands, reset after each activation
   */
  protected commands: coresdk.workflow_commands.IWorkflowCommand[] = [];

  /**
   * Stores all {@link condition}s that haven't been unblocked yet
   */
  public readonly blockedConditions = new Map<number, Condition>();

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
  protected cancelled = false;

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
   * May be accessed and modified from outside the VM.
   */
  now: number;

  /**
   * Reference to the current Workflow, initialized when a Workflow is started
   */
  public workflow?: Workflow;

  /**
   * Information about the current Workflow
   * May be accessed from outside the VM.
   */
  public info: WorkflowInfo;

  /**
   * A deterministic RNG, used by the isolate's overridden Math.random
   */
  public random: RNG;

  public payloadConverter: PayloadConverter = defaultPayloadConverter;
  public failureConverter: FailureConverter = defaultFailureConverter;

  /**
   * Patches we know the status of for this workflow, as in {@link patched}
   */
  private readonly knownPresentPatches = new Set<string>();

  /**
   * Patches we sent to core {@link patched}
   */
  private readonly sentPatches = new Set<string>();

  private readonly knownFlags = new Set<number>();

  /**
   * Buffered sink calls per activation
   */
  sinkCalls = Array<SinkCall>();

  /**
   * A nanosecond resolution time function, externally injected
   */
  public readonly getTimeOfDay: () => bigint;

  public readonly registeredActivityNames: Set<string>;

  constructor({
    info,
    now,
    showStackTraceSources,
    sourceMap,
    getTimeOfDay,
    randomnessSeed,
    registeredActivityNames,
  }: WorkflowCreateOptionsInternal) {
    this.getTimeOfDay = getTimeOfDay;
    this.info = info;
    this.now = now;
    this.showStackTraceSources = showStackTraceSources;
    this.sourceMap = sourceMap;
    this.random = alea(randomnessSeed);
    this.registeredActivityNames = registeredActivityNames;
  }

  /**
   * May be invoked from outside the VM.
   */
  mutateWorkflowInfo(fn: (info: WorkflowInfo) => WorkflowInfo): void {
    this.info = fn(this.info);
  }

  protected getStackTraces(): Stack[] {
    const { childToParent, promiseToStack } = this.promiseStackStore;
    const internalNodes = [...childToParent.values()].reduce((acc, curr) => {
      for (const p of curr) {
        acc.add(p);
      }
      return acc;
    }, new Set());
    const stacks = new Map<string, Stack>();
    for (const child of childToParent.keys()) {
      if (!internalNodes.has(child)) {
        const stack = promiseToStack.get(child);
        if (!stack || !stack.formatted) continue;
        stacks.set(stack.formatted, stack);
      }
    }
    // Not 100% sure where this comes from, just filter it out
    stacks.delete('    at Promise.then (<anonymous>)');
    stacks.delete('    at Promise.then (<anonymous>)\n');
    return [...stacks].map(([_, stack]) => stack);
  }

  /**
   * May be invoked from outside the VM.
   */
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
    this.commands.push(cmd);
    if (complete) {
      this.completed = true;
    }
  }

  concludeActivation(): ActivationCompletion {
    return {
      commands: this.commands.splice(0),
      usedInternalFlags: [...this.knownFlags],
    };
  }

  public async startWorkflowNextHandler({ args }: WorkflowExecuteInput): Promise<any> {
    const { workflow } = this;
    if (workflow === undefined) {
      throw new IllegalStateError('Workflow uninitialized');
    }
    return await workflow(...args);
  }

  public startWorkflow(activation: coresdk.workflow_activation.IInitializeWorkflow): void {
    const execute = composeInterceptors(this.interceptors.inbound, 'execute', this.startWorkflowNextHandler.bind(this));

    untrackPromise(
      executeWithLifecycleLogging(() =>
        execute({
          headers: activation.headers ?? {},
          args: arrayFromPayloads(this.payloadConverter, activation.arguments),
        })
      ).then(this.completeWorkflow.bind(this), this.handleWorkflowFailure.bind(this))
    );
  }

  public initializeWorkflow(activation: coresdk.workflow_activation.IInitializeWorkflow): void {
    const { continuedFailure, lastCompletionResult, memo, searchAttributes } = activation;

    // Most things related to initialization have already been handled in the constructor
    this.mutateWorkflowInfo((info) => ({
      ...info,
      searchAttributes:
        (mapFromPayloads(searchAttributePayloadConverter, searchAttributes?.indexedFields) as SearchAttributes) ?? {},
      memo: mapFromPayloads(this.payloadConverter, memo?.fields),
      lastResult: fromPayloadsAtIndex(this.payloadConverter, 0, lastCompletionResult?.payloads),
      lastFailure:
        continuedFailure != null
          ? this.failureConverter.failureToError(continuedFailure, this.payloadConverter)
          : undefined,
    }));
  }

  public cancelWorkflow(_activation: coresdk.workflow_activation.ICancelWorkflow): void {
    this.cancelled = true;
    this.rootScope.cancel();
  }

  public fireTimer(activation: coresdk.workflow_activation.IFireTimer): void {
    // Timers are a special case where their completion might not be in Workflow state,
    // this is due to immediate timer cancellation that doesn't go wait for Core.
    const completion = this.maybeConsumeCompletion('timer', getSeq(activation));
    completion?.resolve(undefined);
  }

  public resolveActivity(activation: coresdk.workflow_activation.IResolveActivity): void {
    if (!activation.result) {
      throw new TypeError('Got ResolveActivity activation with no result');
    }
    const { resolve, reject } = this.consumeCompletion('activity', getSeq(activation));
    if (activation.result.completed) {
      const completed = activation.result.completed;
      const result = completed.result ? this.payloadConverter.fromPayload(completed.result) : undefined;
      resolve(result);
    } else if (activation.result.failed) {
      const { failure } = activation.result.failed;
      const err = failure ? this.failureToError(failure) : undefined;
      reject(err);
    } else if (activation.result.cancelled) {
      const { failure } = activation.result.cancelled;
      const err = failure ? this.failureToError(failure) : undefined;
      reject(err);
    } else if (activation.result.backoff) {
      reject(new LocalActivityDoBackoff(activation.result.backoff));
    }
  }

  public resolveChildWorkflowExecutionStart(
    activation: coresdk.workflow_activation.IResolveChildWorkflowExecutionStart
  ): void {
    const { resolve, reject } = this.consumeCompletion('childWorkflowStart', getSeq(activation));
    if (activation.succeeded) {
      resolve(activation.succeeded.runId);
    } else if (activation.failed) {
      if (decodeStartChildWorkflowExecutionFailedCause(activation.failed.cause) !== 'WORKFLOW_ALREADY_EXISTS') {
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
      reject(this.failureToError(activation.cancelled.failure));
    } else {
      throw new TypeError('Got ResolveChildWorkflowExecutionStart with no status');
    }
  }

  public resolveChildWorkflowExecution(activation: coresdk.workflow_activation.IResolveChildWorkflowExecution): void {
    if (!activation.result) {
      throw new TypeError('Got ResolveChildWorkflowExecution activation with no result');
    }
    const { resolve, reject } = this.consumeCompletion('childWorkflowComplete', getSeq(activation));
    if (activation.result.completed) {
      const completed = activation.result.completed;
      const result = completed.result ? this.payloadConverter.fromPayload(completed.result) : undefined;
      resolve(result);
    } else if (activation.result.failed) {
      const { failure } = activation.result.failed;
      if (failure === undefined || failure === null) {
        throw new TypeError('Got failed result with no failure attribute');
      }
      reject(this.failureToError(failure));
    } else if (activation.result.cancelled) {
      const { failure } = activation.result.cancelled;
      if (failure === undefined || failure === null) {
        throw new TypeError('Got cancelled result with no failure attribute');
      }
      reject(this.failureToError(failure));
    }
  }

  // Intentionally non-async function so this handler doesn't show up in the stack trace
  protected queryWorkflowNextHandler({ queryName, args }: QueryInput): Promise<unknown> {
    const fn = this.queryHandlers.get(queryName)?.handler;
    if (fn === undefined) {
      const knownQueryTypes = [...this.queryHandlers.keys()].join(' ');
      // Fail the query
      return Promise.reject(
        new ReferenceError(
          `Workflow did not register a handler for ${queryName}. Registered queries: [${knownQueryTypes}]`
        )
      );
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
    const { queryType, queryId, headers } = activation;
    if (!(queryType && queryId)) {
      throw new TypeError('Missing query activation attributes');
    }

    const execute = composeInterceptors(
      this.interceptors.inbound,
      'handleQuery',
      this.queryWorkflowNextHandler.bind(this)
    );
    execute({
      queryName: queryType,
      args: arrayFromPayloads(this.payloadConverter, activation.arguments),
      queryId,
      headers: headers ?? {},
    }).then(
      (result) => this.completeQuery(queryId, result),
      (reason) => this.failQuery(queryId, reason)
    );
  }

  public doUpdate(activation: coresdk.workflow_activation.IDoUpdate): void {
    const { id: updateId, protocolInstanceId, name, headers, runValidator } = activation;
    if (!updateId) {
      throw new TypeError('Missing activation update id');
    }
    if (!name) {
      throw new TypeError('Missing activation update name');
    }
    if (!protocolInstanceId) {
      throw new TypeError('Missing activation update protocolInstanceId');
    }
    const entry = this.updateHandlers.get(name);
    if (!entry) {
      this.bufferedUpdates.push(activation);
      return;
    }

    const makeInput = (): UpdateInput => ({
      updateId,
      args: arrayFromPayloads(this.payloadConverter, activation.input),
      name,
      headers: headers ?? {},
    });

    // The implementation below is responsible for upholding, and constrained
    // by, the following contract:
    //
    // 1. If no validator is present then validation interceptors will not be run.
    //
    // 2. During validation, any error must fail the Update; during the Update
    //    itself, Temporal errors fail the Update whereas other errors fail the
    //    activation.
    //
    // 3. The handler must not see any mutations of the arguments made by the
    //    validator.
    //
    // 4. Any error when decoding/deserializing input must be caught and result
    //    in rejection of the Update before it is accepted, even if there is no
    //    validator.
    //
    // 5. The initial synchronous portion of the (async) Update handler should
    //    be executed after the (sync) validator completes such that there is
    //    minimal opportunity for a different concurrent task to be scheduled
    //    between them.
    //
    // 6. The stack trace view provided in the Temporal UI must not be polluted
    //    by promises that do not derive from user code. This implies that
    //    async/await syntax may not be used.
    //
    // Note that there is a deliberately unhandled promise rejection below.
    // These are caught elsewhere and fail the corresponding activation.
    const doUpdateImpl = async () => {
      let input: UpdateInput;
      try {
        if (runValidator && entry.validator) {
          const validate = composeInterceptors(
            this.interceptors.inbound,
            'validateUpdate',
            this.validateUpdateNextHandler.bind(this, entry.validator)
          );
          validate(makeInput());
        }
        input = makeInput();
      } catch (error) {
        this.rejectUpdate(protocolInstanceId, error);
        return;
      }
      this.acceptUpdate(protocolInstanceId);
      const execute = composeInterceptors(
        this.interceptors.inbound,
        'handleUpdate',
        this.updateNextHandler.bind(this, entry.handler)
      );
      const { unfinishedPolicy } = entry;
      this.inProgressUpdates.set(updateId, { name, unfinishedPolicy, id: updateId });
      const res = execute(input)
        .then((result) => this.completeUpdate(protocolInstanceId, result))
        .catch((error) => {
          if (error instanceof TemporalFailure) {
            this.rejectUpdate(protocolInstanceId, error);
          } else {
            throw error;
          }
        })
        .finally(() => this.inProgressUpdates.delete(updateId));
      untrackPromise(res);
      return res;
    };
    untrackPromise(UpdateScope.updateWithInfo(updateId, name, doUpdateImpl));
  }

  protected async updateNextHandler(handler: WorkflowUpdateType, { args }: UpdateInput): Promise<unknown> {
    return await handler(...args);
  }

  protected validateUpdateNextHandler(validator: WorkflowUpdateValidatorType | undefined, { args }: UpdateInput): void {
    if (validator) {
      validator(...args);
    }
  }

  public dispatchBufferedUpdates(): void {
    const bufferedUpdates = this.bufferedUpdates;
    while (bufferedUpdates.length) {
      const foundIndex = bufferedUpdates.findIndex((update) => this.updateHandlers.has(update.name as string));
      if (foundIndex === -1) {
        // No buffered Updates have a handler yet.
        break;
      }
      const [update] = bufferedUpdates.splice(foundIndex, 1);
      this.doUpdate(update);
    }
  }

  public rejectBufferedUpdates(): void {
    while (this.bufferedUpdates.length) {
      const update = this.bufferedUpdates.shift();
      if (update) {
        this.rejectUpdate(
          /* eslint-disable @typescript-eslint/no-non-null-assertion */
          update.protocolInstanceId!,
          ApplicationFailure.nonRetryable(`No registered handler for update: ${update.name}`)
        );
      }
    }
  }

  public async signalWorkflowNextHandler({ signalName, args }: SignalInput): Promise<void> {
    const fn = this.signalHandlers.get(signalName)?.handler;
    if (fn) {
      return await fn(...args);
    } else if (this.defaultSignalHandler) {
      return await this.defaultSignalHandler(signalName, ...args);
    } else {
      throw new IllegalStateError(`No registered signal handler for signal: ${signalName}`);
    }
  }

  public signalWorkflow(activation: coresdk.workflow_activation.ISignalWorkflow): void {
    const { signalName, headers } = activation;
    if (!signalName) {
      throw new TypeError('Missing activation signalName');
    }

    if (!this.signalHandlers.has(signalName) && !this.defaultSignalHandler) {
      this.bufferedSignals.push(activation);
      return;
    }

    // If we fall through to the default signal handler then the unfinished
    // policy is WARN_AND_ABANDON; users currently have no way to silence any
    // ensuing warnings.
    const unfinishedPolicy =
      this.signalHandlers.get(signalName)?.unfinishedPolicy ?? HandlerUnfinishedPolicy.WARN_AND_ABANDON;

    const signalExecutionNum = this.signalHandlerExecutionSeq++;
    this.inProgressSignals.set(signalExecutionNum, { name: signalName, unfinishedPolicy });
    const execute = composeInterceptors(
      this.interceptors.inbound,
      'handleSignal',
      this.signalWorkflowNextHandler.bind(this)
    );
    execute({
      args: arrayFromPayloads(this.payloadConverter, activation.input),
      signalName,
      headers: headers ?? {},
    })
      .catch(this.handleWorkflowFailure.bind(this))
      .finally(() => this.inProgressSignals.delete(signalExecutionNum));
  }

  public dispatchBufferedSignals(): void {
    const bufferedSignals = this.bufferedSignals;
    while (bufferedSignals.length) {
      if (this.defaultSignalHandler) {
        // We have a default signal handler, so all signals are dispatchable
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.signalWorkflow(bufferedSignals.shift()!);
      } else {
        const foundIndex = bufferedSignals.findIndex((signal) => this.signalHandlers.has(signal.signalName as string));
        if (foundIndex === -1) break;
        const [signal] = bufferedSignals.splice(foundIndex, 1);
        this.signalWorkflow(signal);
      }
    }
  }

  public resolveSignalExternalWorkflow(activation: coresdk.workflow_activation.IResolveSignalExternalWorkflow): void {
    const { resolve, reject } = this.consumeCompletion('signalWorkflow', getSeq(activation));
    if (activation.failure) {
      reject(this.failureToError(activation.failure));
    } else {
      resolve(undefined);
    }
  }

  public resolveRequestCancelExternalWorkflow(
    activation: coresdk.workflow_activation.IResolveRequestCancelExternalWorkflow
  ): void {
    const { resolve, reject } = this.consumeCompletion('cancelWorkflow', getSeq(activation));
    if (activation.failure) {
      reject(this.failureToError(activation.failure));
    } else {
      resolve(undefined);
    }
  }

  public warnIfUnfinishedHandlers(): void {
    const getWarnable = (handlerExecutions: Iterable<MessageHandlerExecution>): MessageHandlerExecution[] => {
      return Array.from(handlerExecutions).filter(
        (ex) => ex.unfinishedPolicy === HandlerUnfinishedPolicy.WARN_AND_ABANDON
      );
    };

    const warnableUpdates = getWarnable(this.inProgressUpdates.values());
    if (warnableUpdates.length > 0) {
      log.warn(makeUnfinishedUpdateHandlerMessage(warnableUpdates));
    }

    const warnableSignals = getWarnable(this.inProgressSignals.values());
    if (warnableSignals.length > 0) {
      log.warn(makeUnfinishedSignalHandlerMessage(warnableSignals));
    }
  }

  public updateRandomSeed(activation: coresdk.workflow_activation.IUpdateRandomSeed): void {
    if (!activation.randomnessSeed) {
      throw new TypeError('Expected activation with randomnessSeed attribute');
    }
    this.random = alea(activation.randomnessSeed.toBytes());
  }

  public notifyHasPatch(activation: coresdk.workflow_activation.INotifyHasPatch): void {
    if (!this.info.unsafe.isReplaying)
      throw new IllegalStateError('Unexpected notifyHasPatch job on non-replay activation');
    if (!activation.patchId) throw new TypeError('notifyHasPatch missing patch id');
    this.knownPresentPatches.add(activation.patchId);
  }

  public patchInternal(patchId: string, deprecated: boolean): boolean {
    if (this.workflow === undefined) {
      throw new IllegalStateError('Patches cannot be used before Workflow starts');
    }
    const usePatch = !this.info.unsafe.isReplaying || this.knownPresentPatches.has(patchId);
    // Avoid sending commands for patches core already knows about.
    // This optimization enables development of automatic patching tools.
    if (usePatch && !this.sentPatches.has(patchId)) {
      this.pushCommand({
        setPatchMarker: { patchId, deprecated },
      });
      this.sentPatches.add(patchId);
    }
    return usePatch;
  }

  /**
   * Called early while handling an activation to register known flags.
   * May be invoked from outside the VM.
   */
  public addKnownFlags(flags: number[]): void {
    for (const flag of flags) {
      assertValidFlag(flag);
      this.knownFlags.add(flag);
    }
  }

  /**
   * Check if an SDK Flag may be considered as enabled for the current Workflow Task.
   *
   * SDK flags play a role similar to the `patched()` API, but are meant for internal usage by the
   * SDK itself. They make it possible for the SDK to evolve its behaviors over time, while still
   * maintaining compatibility with Workflow histories produced by older SDKs, without causing
   * determinism violations.
   *
   * May be invoked from outside the VM.
   */
  public hasFlag(flag: SdkFlag): boolean {
    if (this.knownFlags.has(flag.id)) return true;

    // If not replaying, enable the flag if it is configured to be enabled by default. Setting a
    // flag's default to false allows progressive rollout of new feature flags, with the possibility
    // of reverting back to a version of the SDK where the flag is supported but disabled by default.
    // It is also useful for testing purpose.
    if (!this.info.unsafe.isReplaying && flag.default) {
      this.knownFlags.add(flag.id);
      return true;
    }

    // When replaying, a flag is considered enabled if it was enabled during the original execution of
    // that Workflow Task; this is normally determined by the presence of the flag ID in the corresponding
    // WFT Completed's `sdkMetadata.langUsedFlags`.
    //
    // SDK Flag Alternate Condition provides an alternative way of determining whether a flag should
    // be considered as enabled for the current WFT; e.g. by looking at the version of the SDK that
    // emitted a WFT. The main use case for this is to retroactively turn on some flags for WFT emitted
    // by previous SDKs that contained a bug. Alt Conditions should only be used as a last resort.
    //
    // Note that conditions are only evaluated while replaying. Also, alternate conditions will not
    // cause the flag to be persisted to the "used flags" set, which means that further Workflow Tasks
    // may not reflect this flag if the condition no longer holds. This is so to avoid incorrect
    // behaviors in case where a Workflow Execution has gone through a newer SDK version then again
    // through an older one.
    if (this.info.unsafe.isReplaying && flag.alternativeConditions) {
      for (const cond of flag.alternativeConditions) {
        if (cond({ info: this.info })) return true;
      }
    }

    return false;
  }

  public removeFromCache(): void {
    throw new IllegalStateError('removeFromCache activation job should not reach workflow');
  }

  /**
   * Transforms failures into a command to be sent to the server.
   * Used to handle any failure emitted by the Workflow.
   */
  async handleWorkflowFailure(error: unknown): Promise<void> {
    if (this.cancelled && isCancellation(error)) {
      this.pushCommand({ cancelWorkflowExecution: {} }, true);
    } else if (error instanceof ContinueAsNew) {
      this.pushCommand({ continueAsNewWorkflowExecution: error.command }, true);
    } else {
      if (!(error instanceof TemporalFailure)) {
        // This results in an unhandled rejection which will fail the activation
        // preventing it from completing.
        throw error;
      }
      // Fail the workflow. We do not want to issue unfinishedHandlers warnings. To achieve that, we
      // mark all handlers as completed now.
      this.inProgressSignals.clear();
      this.inProgressUpdates.clear();
      this.pushCommand(
        {
          failWorkflowExecution: {
            failure: this.errorToFailure(error),
          },
        },
        true
      );
    }
  }

  private completeQuery(queryId: string, result: unknown): void {
    this.pushCommand({
      respondToQuery: { queryId, succeeded: { response: this.payloadConverter.toPayload(result) } },
    });
  }

  private failQuery(queryId: string, error: unknown): void {
    this.pushCommand({
      respondToQuery: {
        queryId,
        failed: this.errorToFailure(ensureTemporalFailure(error)),
      },
    });
  }

  private acceptUpdate(protocolInstanceId: string): void {
    this.pushCommand({ updateResponse: { protocolInstanceId, accepted: {} } });
  }

  private completeUpdate(protocolInstanceId: string, result: unknown): void {
    this.pushCommand({
      updateResponse: { protocolInstanceId, completed: this.payloadConverter.toPayload(result) },
    });
  }

  private rejectUpdate(protocolInstanceId: string, error: unknown): void {
    this.pushCommand({
      updateResponse: {
        protocolInstanceId,
        rejected: this.errorToFailure(ensureTemporalFailure(error)),
      },
    });
  }

  /** Consume a completion if it exists in Workflow state */
  private maybeConsumeCompletion(type: keyof Activator['completions'], taskSeq: number): Completion | undefined {
    const completion = this.completions[type].get(taskSeq);
    if (completion !== undefined) {
      this.completions[type].delete(taskSeq);
    }
    return completion;
  }

  /** Consume a completion if it exists in Workflow state, throws if it doesn't */
  private consumeCompletion(type: keyof Activator['completions'], taskSeq: number): Completion {
    const completion = this.maybeConsumeCompletion(type, taskSeq);
    if (completion === undefined) {
      throw new IllegalStateError(`No completion for taskSeq ${taskSeq}`);
    }
    return completion;
  }

  private completeWorkflow(result: unknown): void {
    this.pushCommand(
      {
        completeWorkflowExecution: {
          result: this.payloadConverter.toPayload(result),
        },
      },
      true
    );
  }

  errorToFailure(err: unknown): ProtoFailure {
    return this.failureConverter.errorToFailure(err, this.payloadConverter);
  }

  failureToError(failure: ProtoFailure): Error {
    return this.failureConverter.failureToError(failure, this.payloadConverter);
  }
}

function getSeq<T extends { seq?: number | null }>(activation: T): number {
  const seq = activation.seq;
  if (seq === undefined || seq === null) {
    throw new TypeError(`Got activation with no seq attribute`);
  }
  return seq;
}

function makeUnfinishedUpdateHandlerMessage(handlerExecutions: MessageHandlerExecution[]): string {
  const message = `
[TMPRL1102] Workflow finished while an update handler was still running. This may have interrupted work that the
update handler was doing, and the client that sent the update will receive a 'workflow execution
already completed' RPCError instead of the update result. You can wait for all update and signal
handlers to complete by using \`await workflow.condition(workflow.allHandlersFinished)\`.
Alternatively, if both you and the clients sending the update are okay with interrupting running handlers
when the workflow finishes, and causing clients to receive errors, then you can disable this warning by
passing an option when setting the handler:
\`workflow.setHandler(myUpdate, myUpdateHandler, {unfinishedPolicy: HandlerUnfinishedPolicy.ABANDON});\`.`
    .replace(/\n/g, ' ')
    .trim();

  return `${message} The following updates were unfinished (and warnings were not disabled for their handler): ${JSON.stringify(
    handlerExecutions.map((ex) => ({ name: ex.name, id: ex.id }))
  )}`;
}

function makeUnfinishedSignalHandlerMessage(handlerExecutions: MessageHandlerExecution[]): string {
  const message = `
[TMPRL1102] Workflow finished while a signal handler was still running. This may have interrupted work that the
signal handler was doing. You can wait for all update and signal handlers to complete by using
\`await workflow.condition(workflow.allHandlersFinished)\`. Alternatively, if both you and the
clients sending the update are okay with interrupting running handlers when the workflow finishes,
then you can disable this warning by passing an option when setting the handler:
\`workflow.setHandler(mySignal, mySignalHandler, {unfinishedPolicy: HandlerUnfinishedPolicy.ABANDON});\`.`

    .replace(/\n/g, ' ')
    .trim();

  const names = new Map<string, number>();
  for (const ex of handlerExecutions) {
    const count = names.get(ex.name) || 0;
    names.set(ex.name, count + 1);
  }

  return `${message} The following signals were unfinished (and warnings were not disabled for their handler): ${JSON.stringify(
    Array.from(names.entries()).map(([name, count]) => ({ name, count }))
  )}`;
}
