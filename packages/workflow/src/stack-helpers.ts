import { maybeGetActivatorUntyped } from './global-attributes';
import type { PromiseStackStore } from './internals';

/**
 * Helper function to remove a promise from being tracked for stack trace query purposes
 */
export function untrackPromise(promise: Promise<unknown>): void {
  const store = (maybeGetActivatorUntyped() as any)?.promiseStackStore as PromiseStackStore | undefined;
  if (!store) return;
  store.childToParent.delete(promise);
  store.promiseToStack.delete(promise);
}
