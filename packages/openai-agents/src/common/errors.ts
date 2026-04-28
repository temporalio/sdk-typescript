import { TemporalFailure } from '@temporalio/common';

/**
 * Error type used by TemporalOpenAIRunner to wrap non-Temporal errors thrown
 * during agent execution. The runner passes an instance of this as the `cause`
 * of an ApplicationFailure so the class name is preserved through serialization
 * (e.g., err.cause.cause.name === 'AgentsWorkflowError' on the client side,
 * or err.cause.name === 'AgentsWorkflowError' inside the workflow).
 */
export class AgentsWorkflowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentsWorkflowError';
  }
}

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
