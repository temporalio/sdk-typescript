/**
 * Tests that SDK throws a DeterminismViolationError when a query handler returns a Promise
 * @module
 */

import { AsyncQuery } from '../interfaces';

const queries = {
  async invalidAsyncMethod(): Promise<boolean> {
    return true;
  },
};

async function main(): Promise<void> {
  // Nothing to do here
}

export const workflow: AsyncQuery = { main, queries };
