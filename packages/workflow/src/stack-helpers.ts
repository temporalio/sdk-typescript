import { maybeGetActivator } from './global-attributes';

/**
 * Helper function to remove a promise from being tracked for stack trace query purposes
 */
export function untrackPromise(promise: Promise<unknown>): void {
  const store = maybeGetActivator()?.promiseStackStore;
  if (!store) return;
  store.childToParent.delete(promise);
  store.promiseToStack.delete(promise);
}
