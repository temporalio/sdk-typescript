import { defineQuery, setHandler, sleep, workflowInfo } from '@temporalio/workflow';

const unsafeRandomQuery = defineQuery<number>('unsafeRandom');
const deterministicRandomQuery = defineQuery<number>('deterministicRandom');

export async function unsafeRandom(): Promise<void> {
  setHandler(unsafeRandomQuery, () => {
    return workflowInfo().unsafe.random();
  });
  setHandler(deterministicRandomQuery, () => {
    return Math.random();
  });
  // Keep workflow alive waiting for queries
  await sleep(100_000);
}
