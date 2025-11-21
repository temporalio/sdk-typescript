/**
 * Overrides some global objects to make them deterministic.
 *
 * @module
 */
import { msToTs } from '@temporalio/common/lib/time';
import { CancellationScope } from './cancellation-scope';
import { DeterminismViolationError } from './errors';
import { getActivator } from './global-attributes';
import { SdkFlags } from './flags';
import { sleep } from './workflow';
import { untrackPromise } from './stack-helpers';

const global = globalThis as any;
const OriginalDate = globalThis.Date;

export function overrideGlobals(): void {
  // Mock any weak reference because GC is non-deterministic and the effect is observable from the Workflow.
  // Workflow developer will get a meaningful exception if they try to use these.
  global.WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in Workflows because v8 GC is non-deterministic');
  };
  global.FinalizationRegistry = function () {
    throw new DeterminismViolationError(
      'FinalizationRegistry cannot be used in Workflows because v8 GC is non-deterministic'
    );
  };

  global.Date = function (...args: unknown[]) {
    if (args.length > 0) {
      return new (OriginalDate as any)(...args);
    }
    return new OriginalDate(getActivator().now);
  };

  global.Date.now = function () {
    return getActivator().now;
  };

  global.Date.parse = OriginalDate.parse.bind(OriginalDate);
  global.Date.UTC = OriginalDate.UTC.bind(OriginalDate);

  global.Date.prototype = OriginalDate.prototype;

  const timeoutCancelationScopes = new Map<number, CancellationScope>();

  /**
   * @param ms sleep duration -  number of milliseconds. If given a negative number, value will be set to 1.
   */
  global.setTimeout = function (cb: (...args: any[]) => any, ms: number, ...args: any[]): number {
    ms = Math.max(1, ms);
    const activator = getActivator();
    if (activator.hasFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation)) {
      // Capture the sequence number that sleep will allocate
      const seq = activator.nextSeqs.timer;
      const timerScope = new CancellationScope({ cancellable: true });
      const sleepPromise = timerScope.run(() => sleep(ms));
      sleepPromise.then(
        () => {
          timeoutCancelationScopes.delete(seq);
          cb(...args);
        },
        () => {
          timeoutCancelationScopes.delete(seq);
        }
      );
      untrackPromise(sleepPromise);
      timeoutCancelationScopes.set(seq, timerScope);
      return seq;
    } else {
      const seq = activator.nextSeqs.timer++;
      // Create a Promise for AsyncLocalStorage to be able to track this completion using promise hooks.
      new Promise((resolve, reject) => {
        activator.completions.timer.set(seq, { resolve, reject });
        activator.pushCommand({
          startTimer: {
            seq,
            startToFireTimeout: msToTs(ms),
          },
        });
      }).then(
        () => cb(...args),
        () => undefined /* ignore cancellation */
      );
      return seq;
    }
  };

  global.clearTimeout = function (handle: number): void {
    const activator = getActivator();
    const timerScope = timeoutCancelationScopes.get(handle);
    if (timerScope) {
      timeoutCancelationScopes.delete(handle);
      timerScope.cancel();
    } else {
      activator.nextSeqs.timer++; // Shouldn't increase seq number, but that's the legacy behavior
      activator.completions.timer.delete(handle);
      activator.pushCommand({
        cancelTimer: {
          seq: handle,
        },
      });
    }
  };

  // activator.random is mutable, don't hardcode its reference
  Math.random = () => getActivator().random();
}
