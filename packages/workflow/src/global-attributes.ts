export function maybeGetActivatorUntyped(): unknown {
  return (globalThis as any).__TEMPORAL_ACTIVATOR__;
}

export function setActivatorUntyped(activator: unknown): void {
  (globalThis as any).__TEMPORAL_ACTIVATOR__ = activator;
}
