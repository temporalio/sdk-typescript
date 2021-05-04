import Long from 'long';
import * as protobufjs from 'protobufjs/minimal';
import * as iface from '@temporalio/proto';
import { defaultDataConverter, arrayFromPayloads } from './converter/data-converter';
import { alea } from './alea';
import { ActivityOptions, CancellationFunction, CancellationFunctionFactory, Scope, Workflow } from './interfaces';
import { CancellationError, IllegalStateError } from './errors';
import { errorToUserCodeFailure } from './common';
import { tsToMs, nullToUndefined } from './time';

export type ResolveFunction<T = any> = (val: T) => any;
export type RejectFunction<E = any> = (val: E) => any;

export interface Completion {
  resolve: ResolveFunction;
  reject: RejectFunction;
  scope: Scope;
}

export type HookType = 'init' | 'resolve' | 'before' | 'after';
export type PromiseHook = (t: HookType, p: Promise<any>, pp?: Promise<any>) => void;
export interface PromiseData {
  scope: Scope;
  cancellable: boolean;
}

export interface Runtime {
  registerPromiseHook(hook: PromiseHook): void;
  setPromiseData(p: Promise<any>, s: PromiseData): void;
  getPromiseData(p: Promise<any>): PromiseData | undefined;
}

/**
 * Track command sequences and callbacks, accumulate commands
 */
export interface State {
  completions: Map<number, Completion>;
  rootScope: Scope;
  scopeStack: Scope[];
  childScopes: Map<Scope, Set<Scope>>;
  commands: iface.coresdk.workflow_commands.IWorkflowCommand[];
  completed: boolean;
  cancelled: boolean;
  nextSeq: number;
  /**
   * This is set every time the workflow executes an activation
   */
  now: number;
  workflow?: Workflow;
  activator?: Activator;
  runtime?: Runtime;
  workflowId?: string;
  taskQueue?: string;
  activityDefaults?: ActivityOptions;
}

protobufjs.util.Long = Long;
protobufjs.configure();

const rootScope: Scope = {
  associated: true,
  requestCancel: () => {
    throw new Error('Root scope cannot be cancelled from within a workflow');
  },
  completeCancel: (err) => {
    rootScopeCancel(err);
  },
};

const rootScopeCancel = propagateCancellation('completeCancel')(() => undefined, rootScope);

export const state: State = {
  completions: new Map(),
  rootScope,
  scopeStack: [rootScope],
  childScopes: new Map(),
  commands: [],
  completed: false,
  cancelled: false,
  nextSeq: 0,
  now: 0,
};

export type HandlerFunction<K extends keyof iface.coresdk.workflow_activation.IWFActivationJob> = (
  activation: NonNullable<iface.coresdk.workflow_activation.IWFActivationJob[K]>
) => void;

export type WorkflowTaskHandler = {
  [P in keyof iface.coresdk.workflow_activation.IWFActivationJob]: HandlerFunction<P>;
};

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

export class Activator implements WorkflowTaskHandler {
  public startWorkflow(activation: iface.coresdk.workflow_activation.IStartWorkflow): void {
    if (state.workflow === undefined) {
      throw new Error('state.workflow is not defined');
    }
    // TODO: support custom converter
    try {
      const retOrPromise = state.workflow.main(...arrayFromPayloads(defaultDataConverter, activation.arguments));
      if (retOrPromise instanceof Promise) {
        retOrPromise.then(completeWorkflow).catch(failWorkflow);
      } else {
        completeWorkflow(retOrPromise);
      }
    } catch (err) {
      failWorkflow(err);
    }
  }

  public cancelWorkflow(_activation: iface.coresdk.workflow_activation.ICancelWorkflow): void {
    state.cancelled = true;
    rootScopeCancel(new CancellationError('Workflow cancelled', 'external'));
  }

  public fireTimer(activation: iface.coresdk.workflow_activation.IFireTimer): void {
    const { resolve } = consumeCompletion(idToSeq(activation.timerId));
    resolve(undefined);
  }

  public resolveActivity(activation: iface.coresdk.workflow_activation.IResolveActivity): void {
    if (!activation.result) {
      throw new Error('Got CompleteActivity activation with no result');
    }
    const { resolve, reject, scope } = consumeCompletion(idToSeq(activation.activityId));
    if (activation.result.completed) {
      const completed = activation.result.completed;
      const result = completed.result ? defaultDataConverter.fromPayload(completed.result) : undefined;
      if (result === undefined) {
        reject(new Error('Failed to convert from payload'));
      } else {
        resolve(result);
      }
    } else if (activation.result.failed) {
      reject(new Error(nullToUndefined(activation.result.failed.failure?.message)));
    } else if (activation.result.canceled) {
      try {
        scope.completeCancel(new CancellationError('Activity cancelled', 'internal'));
      } catch (e) {
        if (!(e instanceof CancellationError)) throw e;
      }
    }
  }

  public queryWorkflow(activation: iface.coresdk.workflow_activation.IQueryWorkflow): void {
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

  public signalWorkflow(activation: iface.coresdk.workflow_activation.ISignalWorkflow): void {
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
    try {
      // TODO: support custom converter
      const retOrPromise = fn(...arrayFromPayloads(defaultDataConverter, activation.input));
      if (retOrPromise instanceof Promise) {
        retOrPromise.catch(failWorkflow);
      }
    } catch (err) {
      failWorkflow(err);
    }
  }

  public updateRandomSeed(activation: iface.coresdk.workflow_activation.IUpdateRandomSeed): void {
    if (!activation.randomnessSeed) {
      throw new Error('Expected activation with randomnessSeed attribute');
    }
    Math.random = alea(activation.randomnessSeed.toBytes());
  }

  public removeFromCache(): void {
    throw new IllegalStateError('removeFromCache activation job should not reach workflow');
  }
}

/**
 * @returns a boolean indicating whether the job was processed or ignored
 */
export function activate(encodedActivation: Uint8Array, jobIndex: number): boolean {
  const activation = iface.coresdk.workflow_activation.WFActivation.decodeDelimited(encodedActivation);
  // job's type is IWFActivationJob which doesn't have the `attributes` property.
  const job = activation.jobs[jobIndex] as iface.coresdk.workflow_activation.WFActivationJob;
  state.now = tsToMs(activation.timestamp);
  if (state.activator === undefined) {
    throw new Error('state.activator is not defined');
  }
  if (job.variant === undefined) {
    throw new Error('Expected job.variant to be defined');
  }
  const variant = job[job.variant];
  if (!variant) {
    throw new Error(`Expected job.${job.variant} to be set`);
  }
  // The only job that can be executed on a completed workflow is a query.
  // We might get other jobs after completion for instance when a single
  // activation contains multiple jobs and the first one completes the workflow.
  if (state.completed && job.variant !== 'queryWorkflow') {
    return false;
  }
  state.activator[job.variant](variant);
  return true;
}

export function concludeActivation(taskToken: Uint8Array): Uint8Array {
  const { commands } = state;
  // TODO: activation failed (should this be done in main node isolate?)
  const encoded = iface.coresdk.workflow_completion.WFActivationCompletion.encodeDelimited({
    taskToken,
    successful: { commands },
  }).finish();
  state.commands = [];
  return encoded;
}

export function currentScope(): Scope {
  const scope = state.scopeStack[state.scopeStack.length - 1];
  if (scope === undefined) {
    throw new Error('No scopes in stack');
  }
  return scope;
}

export function pushScope(scope: Scope): Scope {
  state.scopeStack.push(scope);
  if (scope.parent === undefined) {
    throw new Error('Tried to push a parentless scope');
  }
  let children = state.childScopes.get(scope.parent);
  if (children === undefined) {
    children = new Set();
    state.childScopes.set(scope.parent, children);
  }
  children.add(scope);
  return scope;
}

export function propagateCancellation(method: 'requestCancel' | 'completeCancel'): CancellationFunctionFactory {
  return (reject: CancellationFunction, scope: Scope): CancellationFunction => {
    return (err: CancellationError) => {
      const children = state.childScopes.get(scope);
      if (children === undefined) {
        throw new Error('Expected to find child scope mapping, got undefined');
      }
      for (const child of children) {
        try {
          child[method](err);
        } catch (e) {
          // TODO: aggregate errors?
          if (e !== err) reject(e);
        }
      }
      // If no children throw, make sure to reject this promise
      reject(err);
    };
  };
}

function cancellationNotSet() {
  throw new Error('Cancellation function not set');
}

export function childScope<T>(
  makeRequestCancellation: CancellationFunctionFactory,
  makeCompleteCancellation: CancellationFunctionFactory,
  fn: () => Promise<T>
): Promise<T> {
  let requestCancel: CancellationFunction = cancellationNotSet;
  let completeCancel: CancellationFunction = cancellationNotSet;

  const scope = pushScope({
    parent: currentScope(),
    requestCancel: (err) => requestCancel(err),
    completeCancel: (err) => completeCancel(err),
    associated: false,
  });
  // eslint-disable-next-line no-async-promise-executor
  const promise = new Promise<T>(async (resolve, reject) => {
    try {
      requestCancel = makeRequestCancellation(reject, scope);
      completeCancel = makeCompleteCancellation(reject, scope);
      const promise = fn();
      const result = await promise;
      resolve(result);
    } catch (e) {
      reject(e);
    }
  });
  state.scopeStack.pop();
  return promise;
}

(globalThis as any).__temporal__ = Object.assign((globalThis as any).__temporal__ || {}, {
  internals: { activate, concludeActivation },
});
