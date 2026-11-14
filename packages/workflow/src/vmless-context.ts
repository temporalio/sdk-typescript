/**
 * Async-local ownership for the experimental VM-less runtime.
 * Selected only by the VM-less bundler.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { IllegalStateError } from '@temporalio/common';
import type { Activator } from './internals';

const storage = new AsyncLocalStorage<Activator>();
const disposed = new WeakSet<Activator>();

export function isDisposed(activator: Activator): boolean {
  return disposed.has(activator);
}

export function runWithActivator<T>(activator: Activator, fn: () => T): T {
  if (disposed.has(activator)) throw new IllegalStateError('Workflow execution was disposed');
  return storage.run(activator, fn);
}

export function runOutsideWorkflowContext<T>(fn: () => T): T {
  return storage.exit(fn);
}

export function maybeGetActivator(): Activator | undefined {
  const activator = storage.getStore();
  // Keep disposed ownership distinct from host code: late callbacks must not fall
  // through to native timers/randomness or issue new workflow commands.
  if (activator && disposed.has(activator)) throw new IllegalStateError('Workflow execution was disposed');
  return activator;
}

export function disposeActivator(activator: Activator): void {
  disposed.add(activator);
  activator.moduleCache.clear();
}

export function assertInWorkflowContext(message: string): Activator {
  const activator = maybeGetActivator();
  if (!activator) throw new IllegalStateError(message);
  return activator;
}

/** @lintignore Consumed as a global-attributes export through the VM-less webpack module replacement. */
export const getActivator = assertInWorkflowContext.bind(null, 'Workflow uninitialized');

/** @lintignore Preserves the internal setActivator export when webpack substitutes this module for global-attributes. */
export function setActivator(): never {
  throw new IllegalStateError('VM-less execution requires scoped activator entry');
}
