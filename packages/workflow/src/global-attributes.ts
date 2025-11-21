import { IllegalStateError } from '@temporalio/common';
import { type Activator } from './internals';

export function maybeGetActivatorUntyped(): unknown {
  return (globalThis as any).__TEMPORAL_ACTIVATOR__;
}

export function setActivatorUntyped(activator: unknown): void {
  (globalThis as any).__TEMPORAL_ACTIVATOR__ = activator;
}

export function maybeGetActivator(): Activator | undefined {
  return maybeGetActivatorUntyped() as Activator | undefined;
}

export function assertInWorkflowContext(message: string): Activator {
  const activator = maybeGetActivator();
  if (activator == null) throw new IllegalStateError(message);
  return activator;
}

export function getActivator(): Activator {
  const activator = maybeGetActivator();
  if (activator === undefined) {
    throw new IllegalStateError('Workflow uninitialized');
  }
  return activator;
}
