/**
 * Tests:
 * - SDK throws a DeterminismViolationError when a query handler returns a Promise
 * - Failed query
 * @module
 */

import { defineQuery, setHandler } from '@temporalio/workflow';

export const invalidAsyncQuery = defineQuery<Promise<boolean>>('invalidAsyncMethod');
export const failQuery = defineQuery<never>('fail');

export async function invalidOrFailedQueries(): Promise<void> {
  setHandler(invalidAsyncQuery, async () => true);
  setHandler(failQuery, () => {
    throw new Error('fail');
  });
}
