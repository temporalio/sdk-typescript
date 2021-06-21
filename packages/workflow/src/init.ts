import { Workflow, WorkflowInfo } from './interfaces';
import { state } from './internals';
import { WorkflowInterceptors } from './interceptors';
import { msToTs } from './time';
import { alea } from './alea';
import { IsolateExtension, HookManager } from './promise-hooks';
import { DeterminismViolationError } from './errors';

export function overrideGlobals(): void {
  const global = globalThis as any;
  // Mock any weak reference holding structures because GC is non-deterministic.
  // WeakRef is implemented in V8 8.4 which is embedded in node >=14.6.0.
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

  // state.random is mutable, don't hardcode its reference
  Math.random = () => state.random();
}

export function initWorkflow(
  workflow: Workflow,
  info: WorkflowInfo,
  randomnessSeed: number[],
  isolateExtension: IsolateExtension,
  interceptors: WorkflowInterceptors
): void {
  // Globals are overridden while building the isolate before loading user code.
  // For some reason the `WeakRef` mock is not restored properly when creating an isolate from snapshot in node 14 (at least on ubuntu), override again.
  (globalThis as any).WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in workflows because v8 GC is non-deterministic');
  };

  state.workflow = workflow;
  state.interceptors = interceptors;
  state.info = info;
  state.random = alea(randomnessSeed);
  HookManager.instance.setIsolateExtension(isolateExtension);
}
