import { Trigger } from '@temporalio/workflow';
import { SimpleQuery } from '../interfaces';

let blocked = true;
const unblocked = new Trigger<void>();

const queries = {
  isBlocked(): boolean {
    return blocked;
  },
  fail(): never {
    throw new Error('Query failed');
  },
};

const signals = {
  unblock(): void {
    unblocked.resolve();
  },
};

async function main(): Promise<void> {
  await unblocked;
  blocked = false;
}

export const workflow: SimpleQuery = { main, queries, signals };
