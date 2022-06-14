import { CancelledFailure, IllegalStateError } from '@temporalio/common';
import type { AsyncLocalStorage as ALS } from 'async_hooks';
import { untrackPromise } from './stack-helpers';

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
  timeout?: number;

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
 * In the SDK, Workflows are represented internally by a tree of scopes where the `execute` function runs in the root scope.
 * Cancellation propagates from outer scopes to inner ones and is handled by catching {@link CancelledFailure}s
 * thrown by cancellable operations (see below).
 *
 * Scopes are created using the `CancellationScope` constructor or the static helper methods
 * {@link cancellable}, {@link nonCancellable} and {@link withTimeout}.
 *
 * When a `CancellationScope` is cancelled, it will propagate cancellation any child scopes and any cancellable
 * operations created within it, such as:
 *
 * - Activities
 * - Child Workflows
 * - Timers (created with the {@link sleep} function)
 * - {@link Trigger}s
 *
 * @example
 *
 * ```ts
 * await CancellationScope.cancellable(async () => {
 *   const promise = someActivity();
 *   CancellationScope.current().cancel(); // Cancels the activity
 *   await promise; // Throws `ActivityFailure` with `cause` set to `CancelledFailure`
 * });
 * ```
 *
 * @example
 *
 * ```ts
 * const scope = new CancellationScope();
 * const promise = scope.run(someActivity);
 * scope.cancel(); // Cancels the activity
 * await promise; // Throws `ActivityFailure` with `cause` set to `CancelledFailure`
 * ```
 */
export class CancellationScope {
  /**
   * Time in milliseconds before the scope cancellation is automatically requested
   */
  protected readonly timeout?: number;

  /**
   * If false, prevent outer cancellation from propagating to inner scopes, Activities, timers, and Triggers, defaults to true.
   * (Scope still propagates CancelledFailure thrown from within)
   */
  public readonly cancellable: boolean;
  /**
   * An optional CancellationScope (useful for running background tasks), defaults to {@link CancellationScope.current}()
   */
  public readonly parent?: CancellationScope;

  /**
   * Rejected when scope cancellation is requested
   */
  public readonly cancelRequested: Promise<never>;

  #cancelRequested = false;

  // Typescript does not understand that the Promise executor runs synchronously in the constructor
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  protected readonly reject: (reason?: any) => void;

  constructor(options?: CancellationScopeOptions) {
    this.timeout = options?.timeout;
    this.cancellable = options?.cancellable ?? true;
    this.cancelRequested = new Promise((_, reject) => {
      // Typescript does not understand that the Promise executor runs synchronously
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
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
      this.#cancelRequested = this.parent.#cancelRequested;
      this.parent.cancelRequested.catch((err) => {
        this.reject(err);
      });
    }
  }

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
    if (this.timeout) {
      untrackPromise(
        sleep(this.timeout).then(
          () => this.cancel(),
          () => {
            // scope was already cancelled, ignore
          }
        )
      );
    }
    return await fn();
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
    return storage.getStore() ?? ROOT_SCOPE;
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
  static withTimeout<T>(timeout: number, fn: () => Promise<T>): Promise<T> {
    return new this({ cancellable: true, timeout }).run(fn);
  }
}

/**
 * This is exported so it can be disposed in the worker interface
 */
export const storage = new AsyncLocalStorage<CancellationScope>();

export class RootCancellationScope extends CancellationScope {
  cancel(): void {
    this.reject(new CancelledFailure('Workflow cancelled'));
  }
}

/** There can only be one of these */
export const ROOT_SCOPE = new RootCancellationScope({ cancellable: true, parent: NO_PARENT });

/** This function is here to avoid a circular dependency between this module and workflow.ts */
let sleep = (_: number | string): Promise<void> => {
  throw new IllegalStateError('Workflow has not been properly initialized');
};

export function registerSleepImplementation(fn: typeof sleep): void {
  sleep = fn;
}
