/**
 * Workflow-aware globals installed only in the dedicated VM-less thread.
 * These are conveniences for workflow semantics, not a safety boundary.
 */
import { msToTs } from '@temporalio/common/lib/time';
import { CancellationScope } from './cancellation-scope';
import { currentRandom } from './current-random';
import { maybeGetActivator } from './vmless-context';
import type { Activator } from './internals';
import { DeterminismViolationError } from './errors';
import { SdkFlags } from './flags';
import { sleep } from './workflow';
import { untrackPromise } from './stack-helpers';
import { log } from './logs';

const OriginalDate = Date;
const originalRandom = Math.random;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalConsole = { ...console };
const timerScopes = new WeakMap<Activator, Map<number, CancellationScope>>();
let installed = false;

function getTimerScopes(activator: Activator): Map<number, CancellationScope> {
  let scopes = timerScopes.get(activator);
  if (!scopes) {
    scopes = new Map();
    timerScopes.set(activator, scopes);
    activator.workflowSandboxDestructors.push(() => scopes!.clear());
  }
  return scopes;
}

export function overrideGlobals(): void {
  if (installed) return;
  installed = true;

  const now = () => maybeGetActivator()?.now ?? OriginalDate.now();
  const dateTarget = OriginalDate.bind(null);
  Object.defineProperties(dateTarget, Object.getOwnPropertyDescriptors(OriginalDate));
  dateTarget.now = now;
  globalThis.Date = new Proxy(dateTarget, {
    apply() {
      return new OriginalDate(now()).toString();
    },
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget);
    },
  });
  Math.random = () => (maybeGetActivator() ? currentRandom() : originalRandom());

  for (const name of ['WeakRef', 'FinalizationRegistry'] as const) {
    globalThis[name] = new Proxy(globalThis[name], {
      construct(target, args, newTarget) {
        if (maybeGetActivator()) {
          throw new DeterminismViolationError(`${name} cannot be used in Workflows because v8 GC is non-deterministic`);
        }
        return Reflect.construct(target, args, newTarget);
      },
    }) as any;
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]) => {
      if (!maybeGetActivator()) return originalConsole[level](...args);
      log[level === 'log' ? 'info' : level](args.map(String).join(' '));
    };
  }

  const setTimeoutDispatch = (cb: (...args: any[]) => any, ms = 0, ...args: any[]): any => {
    const activator = maybeGetActivator();
    if (!activator) return originalSetTimeout(cb, ms, ...args);
    ms = Math.max(1, ms);
    const scopes = getTimerScopes(activator);
    if (activator.hasFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation)) {
      const seq = activator.nextSeqs.timer;
      const scope = new CancellationScope({ cancellable: true });
      const promise = scope.run(() => sleep(ms));
      promise.then(
        () => {
          scopes.delete(seq);
          cb(...args);
        },
        () => {
          scopes.delete(seq);
        }
      );
      untrackPromise(promise);
      scopes.set(seq, scope);
      return seq;
    }
    const seq = activator.nextSeqs.timer++;
    new Promise((resolve, reject) => {
      activator.completions.timer.set(seq, { resolve, reject });
      activator.pushCommand({ startTimer: { seq, startToFireTimeout: msToTs(ms) } });
    }).then(
      () => cb(...args),
      () => undefined
    );
    return seq;
  };
  globalThis.setTimeout = Object.assign(setTimeoutDispatch, originalSetTimeout);
  globalThis.clearTimeout = (handle: any): void => {
    const activator = maybeGetActivator();
    if (!activator) return originalClearTimeout(handle);
    const scopes = getTimerScopes(activator);
    const scope = scopes.get(handle);
    if (scope) {
      scopes.delete(handle);
      scope.cancel();
    } else {
      activator.nextSeqs.timer++; // Preserve the legacy timer sequence behavior.
      activator.completions.timer.delete(handle);
      activator.pushCommand({ cancelTimer: { seq: handle } });
    }
  };
}
