/**
 * Tests:
 * - SDK throws a DeterminismViolationError when a query handler returns a Promise
 * - Failed query
 * @module
 */

export const queries = {
  async invalidAsyncMethod(): Promise<boolean> {
    return true;
  },
  fail(): never {
    throw new Error('fail');
  },
};

export async function main(): Promise<void> {
  // Nothing to do here
}
