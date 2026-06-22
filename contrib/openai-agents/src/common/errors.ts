import { TemporalFailure } from '@temporalio/common';

/**
 * Walks nested `cause` chains and AggregateError `errors` arrays to find the
 * first TemporalFailure. Cycle-safe via visited set.
 */
export function unwrapTemporalFailure(error: unknown): TemporalFailure | undefined {
  const visited = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (current instanceof TemporalFailure) return current;
    if (current instanceof AggregateError) {
      for (const inner of current.errors) {
        stack.push(inner);
      }
    }
    stack.push((current as any).cause);
  }
  return undefined;
}
