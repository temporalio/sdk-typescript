import { AbortSignal } from 'abort-controller';

// Thrown in an activity
export class CancellationError extends Error {
  public readonly name: string = 'CancellationError';
}

/**
 * The runtime context of a single activity invocation
 */
export interface Context {
  /**
   * Send a heartbeat from an activity
   */
  heartbeat(details: any): void;
  /**
   * Await this promise in an activity to get notified of cancellation
   */
  cancelled: Promise<never>;
  /**
   * An `AbortSignal` which can be used to cancel fetch requests on activity cancellation
   */
  cancellationSignal: AbortSignal;
}

export interface AsyncLocalStorage<T> {
  getStore(): T | undefined;
  run<A extends any[], R>(store: T, callback: (...args: A) => Promise<R>, ...args: A): Promise<R>;
}
