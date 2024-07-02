import type { AsyncLocalStorage as ALS } from 'node:async_hooks';
import { CancelledFailure, Duration, IllegalStateError } from '@temporalio/common';
import { msOptionalToNumber } from '@temporalio/common/lib/time';
import { untrackPromise } from './stack-helpers';
import { getActivator } from './global-attributes';
import { SdkFlags } from './flags';

// AsyncLocalStorage is injected via vm module into global scope.
// In case Workflow code is imported in Node.js context, replace with an empty class.
export const AsyncLocalStorage: new <T>() => ALS<T> = (globalThis as any).AsyncLocalStorage ?? class {};

/** Magic symbol used to create the root scope - intentionally not exported */
const NO_PARENT = Symbol('NO_PARENT');

/**
 * Option for constructing a CancellationScope
 */
export interface CancellationScopeOptions {
  /**
   * Time in milliseconds before the scope cancellation is automatically requested
   */
  timeout?: Duration;

  /**
   * If false, prevent outer cancellation from propagating to inner scopes, Activities, timers, and Triggers, defaults to true.
   * (Scope still propagates CancelledFailure thrown from within).
   */
  cancellable: boolean;
  /**
   * An optional CancellationScope (useful for running background tasks).
   * The `NO_PARENT` symbol is reserved for the root scope.
   */
  parent?: CancellationScope | typeof NO_PARENT;
}

/**
 * Cancellation Scopes provide the mechanic by which a Workflow may gracefully handle incoming requests for cancellation
 * (e.g. in response to {@link WorkflowHandle.cancel} or through the UI or CLI), as well as request cancelation of
 * cancellable operations it owns (e.g. Activities, Timers, Child Workflows, etc).
 *
 * Cancellation Scopes form a tree, with the Workflow's main function running in the root scope of that tree.
 * By default, cancellation propagates down from a parent scope to its children and its cancellable operations.
 * A non-cancellable scope can receive cancellation requests, but is never effectively considered as cancelled,
 * thus shieldding its children and cancellable operations from propagation of cancellation requests it receives.
 *
 * Scopes are created using the `CancellationScope` constructor or the static helper methods {@link cancellable},
 * {@link nonCancellable} and {@link withTimeout}. `withTimeout` creates a scope that automatically cancels itself after
 * some duration.
 *
 * Cancellation of a cancellable scope results in all operations created directly in that scope to throw a
 * {@link CancelledFailure} (either directly, or as the `cause` of an {@link ActivityFailure} or a
 * {@link ChildWorkflowFailure}). Further attempt to create new cancellable scopes or cancellable operations within a
 * scope that has already been cancelled will also immediately throw a {@link CancelledFailure} exception. It is however
 * possible to create a non-cancellable scope at that point; this is often used to execute rollback or cleanup
 * operations. For example:
 *
 * ```ts
 * async function myWorkflow(...): Promise<void> {
 *   try {
 *     // This activity runs in the root cancellation scope. Therefore, a cancelation request on
 *     // the Workflow execution (e.g. through the UI or CLI) automatically propagates to this
 *     // activity. Assuming that the activity properly handle the cancellation request, then the
 *     // call below will throw an `ActivityFailure` exception, with `cause` sets to an
 *     // instance of `CancelledFailure`.
 *     await someActivity();
 *   } catch (e) {
 *     if (isCancellation(e)) {
 *       // Run cleanup activity in a non-cancellable scope
 *       await CancellationScope.nonCancellable(async () => {
 *         await cleanupActivity();
 *       }
 *     } else {
 *       throw e;
 *     }
 *   }
 * }
 * ```
 *
 * A cancellable scope may be programatically cancelled by calling {@link cancel|`scope.cancel()`}`. This may be used,
 * for example, to explicitly request cancellation of an Activity or Child Workflow:
 *
 * ```ts
 * const cancellableActivityScope = new CancellationScope();
 * const activityPromise = cancellableActivityScope.run(() => someActivity());
 * cancellableActivityScope.cancel(); // Cancels the activity
 * await activityPromise; // Throws `ActivityFailure` with `cause` set to `CancelledFailure`
 * ```
 */
export class CancellationScope {
  /**
   * Time in milliseconds before the scope cancellation is automatically requested
   */
  protected readonly timeout?: number;

  /**
   * If false, then this scope will never be considered cancelled, even if a cancellation request is received (either
   * directly by calling `scope.cancel()` or indirectly by cancelling a cancellable parent scope). This effectively
   * shields the scope's children and cancellable operations from propagation of cancellation requests made on the
   * non-cancellable scope.
   *
   * Note that the Promise returned by the `run` function of non-cancellable scope may still throw a `CancelledFailure`
   * if such an exception is thrown from within that scope (e.g. by directly cancelling a cancellable child scope).
   */
  public readonly cancellable: boolean;

  /**
   * An optional CancellationScope (useful for running background tasks), defaults to {@link CancellationScope.current}()
   */
  public readonly parent?: CancellationScope;

  /**
   * A Promise that throws when a cancellable scope receives a cancellation request, either directly
   * (i.e. `scope.cancel()`), or indirectly (by cancelling a cancellable parent scope).
   *
   * Note that a non-cancellable scope may receive cancellation requests, resulting in the `cancelRequested` promise for
   * that scope to throw, though the scope will not effectively get cancelled (i.e. `consideredCancelled` will still
   * return `false`, and cancellation will not be propagated to child scopes and contained operations).
   */
  public readonly cancelRequested: Promise<never>;

  #cancelRequested = false;

  // Typescript does not understand that the Promise executor runs synchronously in the constructor
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  protected readonly reject: (reason?: any) => void;

  constructor(options?: CancellationScopeOptions) {
    this.timeout = msOptionalToNumber(options?.timeout);
    this.cancellable = options?.cancellable ?? true;
    this.cancelRequested = new Promise((_, reject) => {
      // @ts-expect-error TSC doesn't understand that the Promise executor runs synchronously
      this.reject = (err) => {
        this.#cancelRequested = true;
        reject(err);
      };
    });
    untrackPromise(this.cancelRequested);
    // Avoid unhandled rejections
    untrackPromise(this.cancelRequested.catch(() => undefined));
    if (options?.parent !== NO_PARENT) {
      this.parent = options?.parent || CancellationScope.current();
      if (
        this.parent.cancellable ||
        (this.parent.#cancelRequested &&
          !getActivator().hasFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation))
      ) {
        this.#cancelRequested = this.parent.#cancelRequested;
        untrackPromise(
          this.parent.cancelRequested.catch((err) => {
            this.reject(err);
          })
        );
      } else {
        untrackPromise(
          this.parent.cancelRequested.catch((err) => {
            if (!getActivator().hasFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation)) {
              this.reject(err);
            }
          })
        );
      }
    }
  }

  /**
   * Whether the scope was effectively cancelled. A non-cancellable scope can never be considered cancelled.
   */
  public get consideredCancelled(): boolean {
    return this.#cancelRequested && this.cancellable;
  }

  /**
   * Activate the scope as current and run  `fn`
   *
   * Any timers, Activities, Triggers and CancellationScopes created in the body of `fn`
   * automatically link their cancellation to this scope.
   *
   * @return the result of `fn`
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return storage.run(this, this.runInContext.bind(this, fn) as () => Promise<T>);
  }

  /**
   * Method that runs a function in AsyncLocalStorage context.
   *
   * Could have been written as anonymous function, made into a method for improved stack traces.
   */
  protected async runInContext<T>(fn: () => Promise<T>): Promise<T> {
    let timerScope: CancellationScope | undefined;
    if (this.timeout) {
      timerScope = new CancellationScope();
      untrackPromise(
        timerScope
          .run(() => sleep(this.timeout as number))
          .then(
            () => this.cancel(),
            () => {
              // scope was already cancelled, ignore
            }
          )
      );
    }
    try {
      return await fn();
    } finally {
      if (
        timerScope &&
        !timerScope.consideredCancelled &&
        getActivator().hasFlag(SdkFlags.NonCancellableScopesAreShieldedFromPropagation)
      ) {
        timerScope.cancel();
      }
    }
  }

  /**
   * Request to cancel the scope and linked children
   */
  cancel(): void {
    this.reject(new CancelledFailure('Cancellation scope cancelled'));
  }

  /**
   * Get the current "active" scope
   */
  static current(): CancellationScope {
    // Using globals directly instead of a helper function to avoid circular import
    return storage.getStore() ?? (globalThis as any).__TEMPORAL_ACTIVATOR__.rootScope;
  }

  /** Alias to `new CancellationScope({ cancellable: true }).run(fn)` */
  static cancellable<T>(fn: () => Promise<T>): Promise<T> {
    return new this({ cancellable: true }).run(fn);
  }

  /** Alias to `new CancellationScope({ cancellable: false }).run(fn)` */
  static nonCancellable<T>(fn: () => Promise<T>): Promise<T> {
    return new this({ cancellable: false }).run(fn);
  }

  /** Alias to `new CancellationScope({ cancellable: true, timeout }).run(fn)` */
  static withTimeout<T>(timeout: Duration, fn: () => Promise<T>): Promise<T> {
    return new this({ cancellable: true, timeout }).run(fn);
  }
}

const storage = new AsyncLocalStorage<CancellationScope>();

/**
 * Avoid exposing the storage directly so it doesn't get frozen
 */
export function disableStorage(): void {
  storage.disable();
}

export class RootCancellationScope extends CancellationScope {
  constructor() {
    super({ cancellable: true, parent: NO_PARENT });
  }

  cancel(): void {
    this.reject(new CancelledFailure('Workflow cancelled'));
  }
}

/** This function is here to avoid a circular dependency between this module and workflow.ts */
let sleep = (_: Duration): Promise<void> => {
  throw new IllegalStateError('Workflow has not been properly initialized');
};

export function registerSleepImplementation(fn: typeof sleep): void {
  sleep = fn;
}
