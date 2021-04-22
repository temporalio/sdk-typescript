import { ActivityOptions, Scope, Workflow } from './interfaces';
import { state, currentScope, Runtime, Activator } from './internals';
import { msToTs } from './time';
import { alea } from './alea';
import { DeterminismViolationError } from './errors';

export function overrideGlobals(randomnessSeed: number[]): void {
  const global = globalThis as any;
  Math.random = alea(randomnessSeed);
  // Mock any weak reference holding structures because GC is non-deterministic.
  // WeakRef is implemented in V8 8.4 which is embedded in node >=14.6.0, delete it just in case.
  // Workflow developer will get a meaningful exception if they try to use these.
  global.WeakMap = function () {
    throw new DeterminismViolationError('WeakMap cannot be used in workflows because v8 GC is non-deterministic');
  };
  global.WeakSet = function () {
    throw new DeterminismViolationError('WeakSet cannot be used in workflows because v8 GC is non-deterministic');
  };
  global.WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in workflows because v8 GC is non-deterministic');
  };

  const OriginalDate = globalThis.Date;

  global.Date = function () {
    return new OriginalDate(state.now);
  };

  global.Date.now = function () {
    return state.now;
  };

  global.Date.prototype = OriginalDate.prototype;

  global.setTimeout = function (cb: (...args: any[]) => any, ms: number, ...args: any[]): number {
    const seq = state.nextSeq++;
    state.completions.set(seq, {
      resolve: () => cb(...args),
      reject: () => undefined /* ignore cancellation */,
      scope: currentScope(),
    });
    state.commands.push({
      startTimer: {
        timerId: `${seq}`,
        startToFireTimeout: msToTs(ms),
      },
    });
    return seq;
  };

  global.clearTimeout = function (handle: number): void {
    state.nextSeq++;
    state.completions.delete(handle);
    state.commands.push({
      cancelTimer: {
        timerId: `${handle}`,
      },
    });
  };
}

export function initWorkflow(
  workflowId: string,
  randomnessSeed: number[],
  taskQueue: string,
  activityDefaults: ActivityOptions,
  runtime: Runtime
): void {
  overrideGlobals(randomnessSeed);

  state.workflowId = workflowId;
  state.taskQueue = taskQueue;
  state.activityDefaults = activityDefaults;
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
