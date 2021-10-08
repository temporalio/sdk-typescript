/**
 * Tests:
 * - SDK throws a DeterminismViolationError when a query handler returns a Promise
 * - Failed query
 * @module
 */

import { defineQuery, setListener } from '@temporalio/workflow';

export const invalidAsyncQuery = defineQuery<Promise<boolean>>('invalidAsyncMethod');
export const failQuery = defineQuery<never>('fail');

export async function invalidOrFailedQueries(): Promise<void> {
  setListener(invalidAsyncQuery, async () => true);
  setListener(failQuery, () => {
    throw new Error('fail');
  });
}
