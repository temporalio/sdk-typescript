import '@temporal-sdk/workflow';
import { SimpleQuery } from '@interfaces';
import { sleep } from './sleep';

let slept = false;

const queries = {
  hasSlept() {
    return slept;
  },
  async hasSleptAsync() {
    return slept;
  },
};

async function main() {
  await sleep(10);
  slept = true;
}

export const workflow: SimpleQuery = { main, queries };
