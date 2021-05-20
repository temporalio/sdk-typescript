import { sleep } from '@temporalio/workflow';
import { SimpleQuery } from '@interfaces';

let slept = false;

const queries = {
  hasSlept(): boolean {
    return slept;
  },
  async hasSleptAsync(): Promise<boolean> {
    return slept;
  },
  fail(): never {
    throw new Error('Query failed');
  },
};

async function main(): Promise<void> {
  await sleep(10);
  slept = true;
}

export const workflow: SimpleQuery = { main, queries };
