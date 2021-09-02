/**
 * Tests:
 * - SDK throws a DeterminismViolationError when a query handler returns a Promise
 * - Failed query
 * @module
 */

interface Queries {
  invalidAsyncMethod(): Promise<boolean>;
  fail(): never;
}

const queries = {
  async invalidAsyncMethod(): Promise<boolean> {
    return true;
  },
  fail(): never {
    throw new Error('fail');
  },
};

async function execute(): Promise<void> {
  // Nothing to do here
}

export function invalidOrFailedQueries(): { execute(): Promise<void>; queries: Queries } {
  return { execute, queries };
}
