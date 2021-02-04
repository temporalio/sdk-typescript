import '@temporal-sdk/workflow';
import { sleep } from './sleep';

let slept = false;

export const queries = {
  hasSlept() {
    return slept;
  },
  async hasSleptAsync() {
    return slept;
  },
};

export async function main() {
  await sleep(10);
  slept = true;
}
