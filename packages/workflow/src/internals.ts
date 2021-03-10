import * as iface from '@temporalio/proto';
import { defaultDataConverter, arrayFromPayloads } from './converter/data-converter';
import { alea } from './alea';
import { CancellationFunction, Workflow } from './interfaces';
import { CancellationError } from './errors';
import { tsToMs, nullToUndefined } from './time';

export interface Scope {
  parent?: Scope;
  cancel: CancellationFunction;
  associated: boolean;
}

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
  commands: iface.coresdk.ICommand[];
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
}

const rootScope: Scope = {
  associated: true,
  cancel: (err) => {
    rootScopeCancel(err);
  },
};

const rootScopeCancel = propagateCancellation(() => undefined, rootScope);

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

export type HandlerFunction<K extends keyof iface.coresdk.IWFActivationJob> = (
  activation: NonNullable<iface.coresdk.IWFActivationJob[K]>
) => void;

export type WorkflowTaskHandler = {
  [P in keyof iface.coresdk.IWFActivationJob]: HandlerFunction<P>;
};

function completeWorkflow(result: any) {
  state.commands.push({
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_COMPLETE_WORKFLOW_EXECUTION,
      completeWorkflowExecutionCommandAttributes: {
        result: defaultDataConverter.toPayloads(result),
      },
    },
  });
  state.completed = true;
}

function failWorkflow(error: any) {
  state.commands.push({
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_FAIL_WORKFLOW_EXECUTION,
      failWorkflowExecutionCommandAttributes: {
        failure: { message: error.message }, // TODO: stackTrace
      },
    },
  });
  state.completed = true;
}

function completeQuery(result: any) {
  state.commands.push({
    core: {
      queryResult: {
        answer: { payloads: [defaultDataConverter.toPayload(result)] },
        resultType: iface.temporal.api.enums.v1.QueryResultType.QUERY_RESULT_TYPE_ANSWERED,
      },
    },
  });
}

function failQuery(error: any) {
  state.commands.push({
    core: {
      queryResult: {
        resultType: iface.temporal.api.enums.v1.QueryResultType.QUERY_RESULT_TYPE_FAILED,
        errorMessage: error.message,
      },
    },
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
  public startWorkflow(activation: iface.coresdk.IStartWorkflow): void {
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

  public cancelWorkflow(_activation: iface.coresdk.ICancelWorkflow): void {
    state.cancelled = true;
    rootScopeCancel(new CancellationError('Workflow cancelled'));
  }

  public fireTimer(activation: iface.coresdk.IFireTimer): void {
    const { resolve } = consumeCompletion(idToSeq(activation.timerId));
    resolve(undefined);
  }

  public cancelTimer(activation: iface.coresdk.ICancelTimer): void {
    const { scope } = consumeCompletion(idToSeq(activation.timerId));
    try {
      scope.cancel(new CancellationError('Timer cancelled'));
    } catch (e) {
      if (!(e instanceof CancellationError)) throw e;
    }
  }

  public resolveActivity(activation: iface.coresdk.IResolveActivity): void {
    if (!activation.result) {
      throw new Error('Got CompleteActivity activation with no result');
    }
    const { resolve, reject, scope } = consumeCompletion(idToSeq(activation.activityId));
    if (activation.result.completed) {
      resolve(defaultDataConverter.fromPayloads(0, activation.result.completed.result));
    } else if (activation.result.failed) {
      reject(new Error(nullToUndefined(activation.result.failed.failure?.message)));
    } else if (activation.result.canceled) {
      try {
        scope.cancel(new CancellationError('Activity cancelled'));
      } catch (e) {
        if (!(e instanceof CancellationError)) throw e;
      }
    }
  }

  public queryWorkflow(job: iface.coresdk.IQueryWorkflow): void {
    if (state.workflow === undefined) {
      throw new Error('state.workflow is not defined');
    }
    // TODO: support custom converter
    try {
      const { queries } = state.workflow;
      if (queries === undefined) {
        throw new Error('Workflow did not define any queries');
      }
      if (!job.query?.queryType) {
        throw new Error('Missing query type');
      }

      const fn = queries[job.query?.queryType];
      const retOrPromise = fn(...arrayFromPayloads(defaultDataConverter, job.query.queryArgs));
      if (retOrPromise instanceof Promise) {
        retOrPromise.then(completeQuery).catch(failQuery);
      } else {
        completeQuery(retOrPromise);
      }
    } catch (err) {
      failQuery(err);
    }
  }

  public signalWorkflow(): void {
    throw new Error('Not implemented');
  }

  public updateRandomSeed(_activation: iface.coresdk.IUpdateRandomSeed): void {
    throw new Error('Not implemented');
  }
}

/**
 * @returns a boolean indicating whether the job was processed or ignored
 */
export function activate(encodedActivation: Uint8Array, jobIndex: number): boolean {
  const activation = iface.coresdk.WFActivation.decodeDelimited(encodedActivation);
  // job's type is IWFActivationJob which doesn't have the `attributes` property.
  const job = activation.jobs[jobIndex] as iface.coresdk.WFActivationJob;
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
  const encoded = iface.coresdk.TaskCompletion.encodeDelimited({
    taskToken,
    workflow: { successful: { commands } },
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

export function propagateCancellation(reject: CancellationFunction, scope: Scope): CancellationFunction {
  return (err: CancellationError) => {
    const children = state.childScopes.get(scope);
    if (children === undefined) {
      throw new Error('Expected to find child scope mapping, got undefined');
    }
    for (const child of children) {
      try {
        child.cancel(err);
      } catch (e) {
        // TODO: aggregate errors?
        if (e !== err) reject(e);
      }
    }
    // If no children throw, make sure to reject this promise
    reject(err);
  };
}

function cancellationNotSet() {
  throw new Error('Cancellation function not set');
}

export function childScope<T>(
  makeCancellation: (reject: CancellationFunction, scope: Scope) => CancellationFunction,
  fn: () => Promise<T>
): Promise<T> {
  let cancel: CancellationFunction = cancellationNotSet;
  const scope = pushScope({
    parent: currentScope(),
    cancel: (err) => cancel(err),
    associated: false,
  });
  // eslint-disable-next-line no-async-promise-executor
  const promise = new Promise<T>(async (resolve, reject) => {
    try {
      cancel = makeCancellation(reject, scope);
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

export function initWorkflow(id: string, runtime: Runtime): void {
  Math.random = alea(id);
  state.runtime = runtime;
  state.activator = new Activator();
  runtime.registerPromiseHook((t, p, pp) => {
    switch (t) {
      case 'init': {
        const scope = currentScope();
        const cancellable = !scope.associated;
        if (pp === undefined) {
          runtime.setPromiseData(p, { scope, cancellable });
        } else {
          let parentScope: Scope;
          let parentData = runtime.getPromiseData(pp);
          if (parentData === undefined) {
            parentScope = scope;
            parentData = { scope: parentScope, cancellable: false };
            runtime.setPromiseData(pp, parentData);
          } else {
            parentScope = parentData.scope;
          }
          runtime.setPromiseData(p, { scope: parentScope, cancellable });
        }
        scope.associated = true;
        break;
      }
      case 'resolve': {
        const data = runtime.getPromiseData(p);
        if (data === undefined) {
          throw new Error('Expected promise to have an associated scope');
        }
        if (data.cancellable) {
          if (data.scope.parent === undefined) {
            throw new Error('Resolved promise for orphan scope');
          }
          const scopes = state.childScopes.get(data.scope.parent);
          if (scopes === undefined) {
            throw new Error('Expected promise to have an associated scope');
          }
          scopes.delete(data.scope);
          if (scopes.size === 0) {
            state.childScopes.delete(data.scope.parent);
          }
        }
      }
    }
  });
}

export function registerWorkflow(workflow: Workflow): void {
  state.workflow = workflow;
}
